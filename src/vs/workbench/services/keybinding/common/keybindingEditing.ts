/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Queue } from 'vs/base/common/async';
import * as json from 'vs/base/common/json';
import { setProperty } from 'vs/base/common/jsonEdit';
import { Edit } from 'vs/base/common/jsonFormatter';
import { Disposable } from 'vs/base/common/lifecycle';
import { isArray } from 'vs/base/common/types';
import { EditOperation } from 'vs/editor/common/core/editOperation';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import { ITextModel } from 'vs/editor/common/model';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { ServiceIdentifier, createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IUserFriendlyKeybinding, USER_KEYBINDINGS_KEY } from 'vs/platform/keybinding/common/keybinding';
import { ResolvedKeybindingItem } from 'vs/platform/keybinding/common/resolvedKeybindingItem';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IUserDataService } from 'vs/workbench/services/userData/common/userData';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { Emitter } from 'vs/base/common/event';
import { LanguageIdentifier } from 'vs/editor/common/modes';
import { Schemas } from 'vs/base/common/network';
import { URI } from 'vs/base/common/uri';

export const IKeybindingEditingService = createDecorator<IKeybindingEditingService>('keybindingEditingService');

export interface IKeybindingEditingService {

	_serviceBrand: ServiceIdentifier<any>;

	userKeybindingsResource: URI;

	editKeybinding(keybindingItem: ResolvedKeybindingItem, key: string, when: string | undefined): Promise<void>;

	removeKeybinding(keybindingItem: ResolvedKeybindingItem): Promise<void>;

	resetKeybinding(keybindingItem: ResolvedKeybindingItem): Promise<void>;
}

export class KeybindingsEditingService extends Disposable implements IKeybindingEditingService {

	public _serviceBrand: any;

	readonly userKeybindingsResource: URI;
	private queue: Queue<void>;

	constructor(
		@IUserDataService private readonly userDataService: IUserDataService,
		@IModeService private readonly modeService: IModeService,
		@IModelService private readonly modelService: IModelService
	) {
		super();
		this.userKeybindingsResource = userDataService.toResource(USER_KEYBINDINGS_KEY);
		this.queue = new Queue<void>();
	}

	editKeybinding(keybindingItem: ResolvedKeybindingItem, key: string, when: string | undefined): Promise<void> {
		return this.queue.queue(() => this.doEditKeybinding(keybindingItem, key, when)); // queue up writes to prevent race conditions
	}

	resetKeybinding(keybindingItem: ResolvedKeybindingItem): Promise<void> {
		return this.queue.queue(() => this.doResetKeybinding(keybindingItem)); // queue up writes to prevent race conditions
	}

	removeKeybinding(keybindingItem: ResolvedKeybindingItem): Promise<void> {
		return this.queue.queue(() => this.doRemoveKeybinding(keybindingItem)); // queue up writes to prevent race conditions
	}

	private doEditKeybinding(keybindingItem: ResolvedKeybindingItem, key: string, when: string | undefined): Promise<void> {
		return this.resolveAndValidate()
			.then(model => {
				const userKeybindingEntries = <IUserFriendlyKeybinding[]>json.parse(model.getValue());
				const userKeybindingEntryIndex = this.findUserKeybindingEntryIndex(keybindingItem, userKeybindingEntries);
				this.updateKeybinding(keybindingItem, key, when, model, userKeybindingEntryIndex);
				if (keybindingItem.isDefault && keybindingItem.resolvedKeybinding) {
					this.removeDefaultKeybinding(keybindingItem, model);
				}
				return this.save(model);
			});
	}

	private doRemoveKeybinding(keybindingItem: ResolvedKeybindingItem): Promise<void> {
		return this.resolveAndValidate()
			.then(model => {
				if (keybindingItem.isDefault) {
					this.removeDefaultKeybinding(keybindingItem, model);
				} else {
					this.removeUserKeybinding(keybindingItem, model);
				}
				return this.save(model);
			});
	}

	private doResetKeybinding(keybindingItem: ResolvedKeybindingItem): Promise<void> {
		return this.resolveAndValidate()
			.then(model => {
				if (!keybindingItem.isDefault) {
					this.removeUserKeybinding(keybindingItem, model);
					this.removeUnassignedDefaultKeybinding(keybindingItem, model);
				}
				return this.save(model);
			});
	}

	private async save(model: ITextModel): Promise<void> {
		await this.userDataService.write(USER_KEYBINDINGS_KEY, model.getValue());
		model.dispose();
		this.modelService.destroyModel(model.uri);
	}

	private updateKeybinding(keybindingItem: ResolvedKeybindingItem, newKey: string, when: string | undefined, model: ITextModel, userKeybindingEntryIndex: number): void {
		const { tabSize, insertSpaces } = model.getOptions();
		const eol = model.getEOL();
		if (userKeybindingEntryIndex !== -1) {
			// Update the keybinding with new key
			this.applyEditsToBuffer(setProperty(model.getValue(), [userKeybindingEntryIndex, 'key'], newKey, { tabSize, insertSpaces, eol })[0], model);
			const edits = setProperty(model.getValue(), [userKeybindingEntryIndex, 'when'], when, { tabSize, insertSpaces, eol });
			if (edits.length > 0) {
				this.applyEditsToBuffer(edits[0], model);
			}
		} else {
			// Add the new keybinding with new key
			this.applyEditsToBuffer(setProperty(model.getValue(), [-1], this.asObject(newKey, keybindingItem.command, when, false), { tabSize, insertSpaces, eol })[0], model);
		}
	}

	private removeUserKeybinding(keybindingItem: ResolvedKeybindingItem, model: ITextModel): void {
		const { tabSize, insertSpaces } = model.getOptions();
		const eol = model.getEOL();
		const userKeybindingEntries = <IUserFriendlyKeybinding[]>json.parse(model.getValue());
		const userKeybindingEntryIndex = this.findUserKeybindingEntryIndex(keybindingItem, userKeybindingEntries);
		if (userKeybindingEntryIndex !== -1) {
			this.applyEditsToBuffer(setProperty(model.getValue(), [userKeybindingEntryIndex], undefined, { tabSize, insertSpaces, eol })[0], model);
		}
	}

	private removeDefaultKeybinding(keybindingItem: ResolvedKeybindingItem, model: ITextModel): void {
		const { tabSize, insertSpaces } = model.getOptions();
		const eol = model.getEOL();
		const key = keybindingItem.resolvedKeybinding ? keybindingItem.resolvedKeybinding.getUserSettingsLabel() : null;
		if (key) {
			this.applyEditsToBuffer(setProperty(model.getValue(), [-1], this.asObject(key, keybindingItem.command, keybindingItem.when ? keybindingItem.when.serialize() : undefined, true), { tabSize, insertSpaces, eol })[0], model);
		}
	}

	private removeUnassignedDefaultKeybinding(keybindingItem: ResolvedKeybindingItem, model: ITextModel): void {
		const { tabSize, insertSpaces } = model.getOptions();
		const eol = model.getEOL();
		const userKeybindingEntries = <IUserFriendlyKeybinding[]>json.parse(model.getValue());
		const indices = this.findUnassignedDefaultKeybindingEntryIndex(keybindingItem, userKeybindingEntries).reverse();
		for (const index of indices) {
			this.applyEditsToBuffer(setProperty(model.getValue(), [index], undefined, { tabSize, insertSpaces, eol })[0], model);
		}
	}

	private findUserKeybindingEntryIndex(keybindingItem: ResolvedKeybindingItem, userKeybindingEntries: IUserFriendlyKeybinding[]): number {
		for (let index = 0; index < userKeybindingEntries.length; index++) {
			const keybinding = userKeybindingEntries[index];
			if (keybinding.command === keybindingItem.command) {
				if (!keybinding.when && !keybindingItem.when) {
					return index;
				}
				if (keybinding.when && keybindingItem.when) {
					const contextKeyExpr = ContextKeyExpr.deserialize(keybinding.when);
					if (contextKeyExpr && contextKeyExpr.serialize() === keybindingItem.when.serialize()) {
						return index;
					}
				}
			}
		}
		return -1;
	}

	private findUnassignedDefaultKeybindingEntryIndex(keybindingItem: ResolvedKeybindingItem, userKeybindingEntries: IUserFriendlyKeybinding[]): number[] {
		const indices: number[] = [];
		for (let index = 0; index < userKeybindingEntries.length; index++) {
			if (userKeybindingEntries[index].command === `-${keybindingItem.command}`) {
				indices.push(index);
			}
		}
		return indices;
	}

	private asObject(key: string, command: string | null, when: string | undefined, negate: boolean): any {
		const object = { key };
		if (command) {
			object['command'] = negate ? `-${command}` : command;
		}
		if (when) {
			object['when'] = when;
		}
		return object;
	}


	private applyEditsToBuffer(edit: Edit, model: ITextModel): void {
		const startPosition = model.getPositionAt(edit.offset);
		const endPosition = model.getPositionAt(edit.offset + edit.length);
		const range = new Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column);
		let currentText = model.getValueInRange(range);
		const editOperation = currentText ? EditOperation.replace(range, edit.content) : EditOperation.insert(startPosition, edit.content);
		model.pushEditOperations([new Selection(startPosition.lineNumber, startPosition.column, startPosition.lineNumber, startPosition.column)], [editOperation], () => []);
	}


	private async resolveModel(): Promise<ITextModel> {
		const content = (await this.userDataService.read(USER_KEYBINDINGS_KEY)) || '[]';
		const languageIdentifier = this.modeService.getLanguageIdentifier('jsonc');
		return this.modelService.createModel(content, languageIdentifier ? { languageIdentifier, onDidChange: new Emitter<LanguageIdentifier>().event, dispose: () => { } } : null, this.userKeybindingsResource.with({ scheme: Schemas.vscode }));
	}

	private async resolveAndValidate(): Promise<ITextModel> {
		const model = await this.resolveModel();
		const EOL = model.getEOL();
		if (model.getValue()) {
			const parsed = this.parse(model);
			if (parsed.parseErrors.length) {
				return Promise.reject<any>(new Error(localize('parseErrors', "Unable to write to the keybindings configuration file. Please open it to correct errors/warnings in the file and try again.")));
			}
			if (parsed.result) {
				if (!isArray(parsed.result)) {
					return Promise.reject<any>(new Error(localize('errorInvalidConfiguration', "Unable to write to the keybindings configuration file. It has an object which is not of type Array. Please open the file to clean up and try again.")));
				}
			} else {
				const content = EOL + '[]';
				this.applyEditsToBuffer({ content, length: content.length, offset: model.getValue().length }, model);
			}
		} else {
			const content = this.getEmptyContent(EOL);
			this.applyEditsToBuffer({ content, length: content.length, offset: 0 }, model);
		}
		return model;
	}

	private parse(model: ITextModel): { result: IUserFriendlyKeybinding[], parseErrors: json.ParseError[] } {
		const parseErrors: json.ParseError[] = [];
		const result = json.parse(model.getValue(), parseErrors);
		return { result, parseErrors };
	}

	private getEmptyContent(EOL: string): string {
		return '// ' + localize('emptyKeybindingsHeader', "Place your key bindings in this file to override the defaults") + EOL + '[]';
	}
}

registerSingleton(IKeybindingEditingService, KeybindingsEditingService, true);