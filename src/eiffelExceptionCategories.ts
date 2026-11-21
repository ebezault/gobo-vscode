import * as vscode from 'vscode';

export interface ExceptionCategory {
	id: string;
	label: string;
	className?: string;
	children?: ExceptionCategory[];
}

export const exceptionCategories: ExceptionCategory[] = [
	{
		id: 'contract',
		label: 'Contract violations',
		children: [
			{ id: 'precondition', label: 'Precondition violation', className: 'PRECONDITION_VIOLATION' },
			{ id: 'postcondition', label: 'Postcondition violation', className: 'POSTCONDITION_VIOLATION' },
			{ id: 'invariant', label: 'Invariant violation', className: 'INVARIANT_VIOLATION' },
			{ id: 'check', label: 'Check instruction violation', className: 'CHECK_VIOLATION' },
			{ id: 'loop_invariant', label: 'Loop invariant violation', className: 'LOOP_INVARIANT_VIOLATION' },
			{ id: 'loop_variant', label: 'Loop variant violation', className: 'VARIANT_VIOLATION' }
		]
	},
	{
		id: 'developer',
		label: 'Developer exceptions',
		children: [
			{ id: 'developer_exception', label: 'Developer exception', className: 'DEVELOPER_EXCEPTION' }
		]
	},
	{
		id: 'language',
		label: 'Language exceptions',
		children: [
			{ id: 'void_target', label: 'Feature call on void target', className: 'VOID_TARGET' },
			{ id: 'routine_failure', label: 'Routine failure', className: 'ROUTINE_FAILURE' },
			{ id: 'inspect_failure', label: 'Unmatched inspect value', className: 'BAD_INSPECT_VALUE' },
			{ id: 'deferred_creation_failure', label: 'Create on deferred', className: 'CREATE_ON_DEFERRED' },
			{ id: 'void_expanded_failure', label: 'Void assigned to expanded', className: 'VOID_ASSIGNED_TO_EXPANDED' },
			{ id: 'old_expression_failure', label: 'Old expression evaluation failed', className: 'OLD_VIOLATION' },
			{ id: 'cecil_melted_code_failure', label: 'CECIL cannot call melted code', className: 'ADDRESS_APPLIED_TO_MELTED_FEATURE' }
		]
	},
	{
		id: 'runtime',
		label: 'Runtime failures',
		children: [
			{ id: 'floating_point_failure', label: 'Floating point failure', className: 'FLOATING_POINT_FAILURE' },
			{ id: 'scoop_processor_dirty', label: 'SCOOP processor dirty' },
			{ id: 'scoop_region_id_overflow', label: 'SCOOP region id overflow' },
			{ id: 'retrieval_error', label: 'Retrieval error', className: 'MISMATCH_FAILURE' },
			{ id: 'serialization_failure', label: 'Serialization failed', className: 'SERIALIZATION_FAILURE' },
			{ id: 'io_failure', label: 'I/O error', className: 'IO_FAILURE' },
			{ id: 'com_failure', label: 'COM error', className: 'COM_FAILURE' },
			{ id: 'no_more_memory', label: 'No more memory', className: 'NO_MORE_MEMORY' },
			{ id: 'out_of_memory', label: 'Out of memory', className: 'NO_MORE_MEMORY' },
			{ id: 'operating_system_signal', label: 'Operating system signal', className: 'OPERATING_SYSTEM_SIGNAL_FAILURE' },
			{ id: 'operating_system_failure', label: 'Operating system error', className: 'OPERATING_SYSTEM_FAILURE' },
			{ id: 'signal_handler_failure', label: 'Exception in signal handler', className: 'EXCEPTION_IN_SIGNAL_HANDLER_FAILURE' },
			{ id: 'eiffel_runtime_io_failure', label: 'Eiffel runtime I/O error', className: 'IO_FAILURE' },
			{ id: 'eiffel_runtime_fatal_failure', label: 'Eiffel runtime fatal error', className: 'EIFFEL_RUNTIME_PANIC' },
			{ id: 'eiffel_runtime_panic', label: 'Eiffel runtime panic', className: 'EIFFEL_RUNTIME_PANIC' },
			{ id: 'eiffel_runtime_check_failure', label: 'Eiffel runtime check violated', className: 'CHECK_VIOLATION' },
			{ id: 'exception_in_rescue_failure', label: 'Exception in rescue clause', className: 'RESCUE_FAILURE' },
			{ id: 'resumption_attempt_failure', label: 'Resumption attempt failed', className: 'RESUMPTION_FAILURE' },
			{ id: 'external_event', label: 'External event', className: 'EXTERNAL_FAILURE' }
		]
	}
];

const STORAGE_KEY = 'goboEiffelExceptionCategories';

function getLeafIds(category: ExceptionCategory): string[] {
	if (!category.children) {
		return [category.id];
	}
	return category.children.flatMap(getLeafIds);
}

export const allExceptionCategoryIds = exceptionCategories.flatMap(getLeafIds);

const validExceptionCategoryIds = new Set(allExceptionCategoryIds);

export function isExceptionCategoryId(
	value: unknown
): value is string {
	return typeof value === 'string' &&
		validExceptionCategoryIds.has(value);
}

export function normalizeExceptionCategories(value: unknown): string[] {
	if (Array.isArray(value)) {
		return allExceptionCategoryIds.filter(
			id => value.includes(id)
		);
	}
	const stored = value && typeof value === 'object'
		? value as Record<string, unknown>
		: {};
	return allExceptionCategoryIds.filter(
		id => stored[id] !== false
	);
}

export class ExceptionCategoryTreeItem extends vscode.TreeItem {
	constructor(
		public readonly category: ExceptionCategory,
		enabledCount: number,
		totalCount: number
	) {
		super(
			category.label,
			category.children
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None
		);

		this.id = category.id;

		if (!category.children) {
			this.checkboxState = enabledCount > 0
				? vscode.TreeItemCheckboxState.Checked
				: vscode.TreeItemCheckboxState.Unchecked;
		}

		if (category.children) {
			this.description = `(${enabledCount} of ${totalCount} enabled)`;
		}

		if (category.className) {
			this.tooltip = new vscode.MarkdownString(
				`\`\`\`eiffel\nclass ${category.className}\n\`\`\``
		);
}

		this.contextValue = category.children
			? 'goboExceptionCategory'
			: 'goboExceptionKind';
	}
}

export class ExceptionCategoryProvider
	implements vscode.TreeDataProvider<ExceptionCategoryTreeItem> {

	private readonly onDidChangeTreeDataEmitter =
		new vscode.EventEmitter<ExceptionCategoryTreeItem | undefined>();

	readonly onDidChangeTreeData =
		this.onDidChangeTreeDataEmitter.event;

	private enabled: Set<string>;

	constructor(private readonly context: vscode.ExtensionContext) {
		const stored = context.globalState.get<Record<string, boolean>>(STORAGE_KEY);

		this.enabled = new Set(
			normalizeExceptionCategories(stored)
		);
	}

	getTreeItem(item: ExceptionCategoryTreeItem): vscode.TreeItem {
		return item;
	}

	getChildren(
		parent?: ExceptionCategoryTreeItem
	): ExceptionCategoryTreeItem[] {
		const categories = parent
			? parent.category.children ?? []
			: exceptionCategories;

		return categories.map(category => {
			const leafIds = getLeafIds(category);
			const enabledCount = leafIds.filter(
				id => this.enabled.has(id)
			).length;

			return new ExceptionCategoryTreeItem(
				category,
				enabledCount,
				leafIds.length
			);
		});
	}

	setChecked(item: ExceptionCategoryTreeItem, checked: boolean): void {
		for (const id of getLeafIds(item.category)) {
			if (checked) {
				this.enabled.add(id);
			} else {
				this.enabled.delete(id);
			}
		}
	}

	getEnabledCategories(): string[] {
		// Return identifiers in a stable, predictable order.
		return allExceptionCategoryIds.filter(
			id => this.enabled.has(id)
		);
	}

	async persist(): Promise<void> {
		const state: Record<string, boolean> = {};

		for (const id of allExceptionCategoryIds) {
			state[id] = this.enabled.has(id);
		}

		await this.context.globalState.update(STORAGE_KEY, state);
	}

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}
}
