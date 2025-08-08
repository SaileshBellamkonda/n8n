import { RestController, Get, Post, Put, Delete, Patch, GlobalScope } from '@n8n/decorators';
import { AuthenticatedRequest } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { VariablesService } from '@/services/variables.service';
import { Logger } from '@n8n/backend-common';
import { Injectable } from '@n8n/di';

interface VariableCreateRequest {
	key: string;
	value: string;
	type: 'string' | 'number' | 'boolean' | 'json' | 'encrypted';
	description?: string;
	tags?: string[];
}

interface VariableUpdateRequest {
	value?: string;
	type?: 'string' | 'number' | 'boolean' | 'json' | 'encrypted';
	description?: string;
	tags?: string[];
}

interface VariableQueryRequest {
	search?: string;
	tags?: string;
	type?: string;
	limit?: string;
	offset?: string;
	orderBy?: 'key' | 'type' | 'createdAt' | 'updatedAt';
	orderDirection?: 'ASC' | 'DESC';
}

interface BulkCreateRequest {
	variables: VariableCreateRequest[];
	overwrite?: boolean;
}

interface ExportRequest {
	includeValues?: boolean;
	format?: 'json' | 'csv';
	keys?: string[];
}

interface ImportRequest {
	data: any[];
	overwrite?: boolean;
	validateOnly?: boolean;
}

@Injectable()
@RestController('/variables')
export class VariablesController {
	constructor(
		private readonly logger: Logger,
		private readonly variablesService: VariablesService,
	) {
		this.logger = this.logger.scoped('variables-controller');
	}

	/**
	 * Create a new variable
	 */
	@Post('/')
	@GlobalScope('variable:create')
	async createVariable(req: AuthenticatedRequest<{}, {}, VariableCreateRequest>) {
		const { key, value, type, description, tags } = req.body;

		if (!key || value === undefined || !type) {
			throw new BadRequestError('Key, value, and type are required');
		}

		const variable = await this.variablesService.createVariable({
			key,
			value,
			type,
			description,
			tags,
		});

		this.logger.info(`Variable created: ${key}`, {
			userId: req.user.id,
			key,
			type,
		});

		return {
			success: true,
			data: variable,
		};
	}

	/**
	 * Get all variables with filtering and pagination
	 */
	@Get('/')
	@GlobalScope('variable:list')
	async getVariables(req: AuthenticatedRequest<{}, VariableQueryRequest>) {
		const {
			search,
			tags,
			type,
			limit = '100',
			offset = '0',
			orderBy = 'key',
			orderDirection = 'ASC',
		} = req.query;

		const parsedLimit = Math.min(parseInt(limit, 10) || 100, 1000);
		const parsedOffset = parseInt(offset, 10) || 0;

		const result = await this.variablesService.getVariables({
			search,
			tags: tags ? tags.split(',') : undefined,
			type,
			limit: parsedLimit,
			offset: parsedOffset,
			orderBy,
			orderDirection,
		});

		return {
			success: true,
			data: result.variables,
			pagination: {
				total: result.total,
				limit: parsedLimit,
				offset: parsedOffset,
				hasMore: parsedOffset + parsedLimit < result.total,
			},
		};
	}

	/**
	 * Get variable by ID
	 */
	@Get('/:id')
	@GlobalScope('variable:read')
	async getVariable(req: AuthenticatedRequest<{ id: string }>) {
		const { id } = req.params;

		const variable = await this.variablesService.getVariable(id);

		if (!variable) {
			throw new BadRequestError('Variable not found');
		}

		return {
			success: true,
			data: variable,
		};
	}

	/**
	 * Get variable by key
	 */
	@Get('/key/:key')
	@GlobalScope('variable:read')
	async getVariableByKey(req: AuthenticatedRequest<{ key: string }>) {
		const { key } = req.params;

		const variable = await this.variablesService.getVariableByKey(key);

		if (!variable) {
			throw new BadRequestError('Variable not found');
		}

		return {
			success: true,
			data: variable,
		};
	}

	/**
	 * Get variable value by key (for workflow execution)
	 */
	@Get('/value/:key')
	@GlobalScope('variable:read')
	async getVariableValue(req: AuthenticatedRequest<{ key: string }>) {
		const { key } = req.params;

		const value = await this.variablesService.getVariableValue(key);

		return {
			success: true,
			data: { key, value },
		};
	}

	/**
	 * Update variable
	 */
	@Put('/:id')
	@GlobalScope('variable:update')
	async updateVariable(req: AuthenticatedRequest<{ id: string }, {}, VariableUpdateRequest>) {
		const { id } = req.params;
		const updateData = req.body;

		const variable = await this.variablesService.updateVariable(id, updateData);

		this.logger.info(`Variable updated: ${variable.key}`, {
			userId: req.user.id,
			variableId: id,
			key: variable.key,
		});

		return {
			success: true,
			data: variable,
		};
	}

	/**
	 * Patch variable (partial update)
	 */
	@Patch('/:id')
	@GlobalScope('variable:update')
	async patchVariable(req: AuthenticatedRequest<{ id: string }, {}, Partial<VariableUpdateRequest>>) {
		const { id } = req.params;
		const updateData = req.body;

		const variable = await this.variablesService.updateVariable(id, updateData);

		this.logger.info(`Variable patched: ${variable.key}`, {
			userId: req.user.id,
			variableId: id,
			key: variable.key,
		});

		return {
			success: true,
			data: variable,
		};
	}

	/**
	 * Delete variable
	 */
	@Delete('/:id')
	@GlobalScope('variable:delete')
	async deleteVariable(req: AuthenticatedRequest<{ id: string }>) {
		const { id } = req.params;

		await this.variablesService.deleteVariable(id);

		this.logger.info(`Variable deleted`, {
			userId: req.user.id,
			variableId: id,
		});

		return {
			success: true,
			message: 'Variable deleted successfully',
		};
	}

	/**
	 * Bulk create variables
	 */
	@Post('/bulk')
	@GlobalScope('variable:create')
	async bulkCreateVariables(req: AuthenticatedRequest<{}, {}, BulkCreateRequest>) {
		const { variables, overwrite = false } = req.body;

		if (!Array.isArray(variables) || variables.length === 0) {
			throw new BadRequestError('Variables array is required and must not be empty');
		}

		if (variables.length > 100) {
			throw new BadRequestError('Cannot create more than 100 variables at once');
		}

		const createdVariables = await this.variablesService.bulkCreateVariables(variables);

		this.logger.info(`Bulk created ${createdVariables.length} variables`, {
			userId: req.user.id,
			count: createdVariables.length,
			overwrite,
		});

		return {
			success: true,
			data: createdVariables,
			count: createdVariables.length,
		};
	}

	/**
	 * Check if variable key is available
	 */
	@Get('/check/:key')
	@GlobalScope('variable:read')
	async checkVariableKeyAvailability(req: AuthenticatedRequest<{ key: string }>) {
		const { key } = req.params;

		const isAvailable = await this.variablesService.isVariableKeyAvailable(key);

		return {
			success: true,
			data: {
				key,
				available: isAvailable,
			},
		};
	}

	/**
	 * Get variables by pattern
	 */
	@Post('/search')
	@GlobalScope('variable:list')
	async searchVariables(req: AuthenticatedRequest<{}, {}, { pattern: string; includeValues?: boolean }>) {
		const { pattern, includeValues = false } = req.body;

		if (!pattern) {
			throw new BadRequestError('Pattern is required');
		}

		const variables = await this.variablesService.getVariablesByPattern(pattern);

		// Remove values if not requested (for security)
		if (!includeValues) {
			variables.forEach(variable => {
				delete variable.value;
			});
		}

		return {
			success: true,
			data: variables,
			count: variables.length,
		};
	}

	/**
	 * Export variables
	 */
	@Post('/export')
	@GlobalScope('variable:read')
	async exportVariables(req: AuthenticatedRequest<{}, {}, ExportRequest>) {
		const { includeValues = false, format = 'json', keys } = req.body;

		const exportData = await this.variablesService.exportVariables(includeValues);

		// Filter by keys if specified
		let filteredData = exportData;
		if (keys && keys.length > 0) {
			filteredData = exportData.filter(variable => keys.includes(variable.key));
		}

		this.logger.info(`Variables exported`, {
			userId: req.user.id,
			count: filteredData.length,
			includeValues,
			format,
		});

		if (format === 'csv') {
			// Convert to CSV format
			const csvData = this.convertToCSV(filteredData);
			return {
				success: true,
				data: csvData,
				format: 'csv',
			};
		}

		return {
			success: true,
			data: filteredData,
			format: 'json',
			count: filteredData.length,
		};
	}

	/**
	 * Import variables
	 */
	@Post('/import')
	@GlobalScope('variable:create')
	async importVariables(req: AuthenticatedRequest<{}, {}, ImportRequest>) {
		const { data, overwrite = false, validateOnly = false } = req.body;

		if (!Array.isArray(data) || data.length === 0) {
			throw new BadRequestError('Data array is required and must not be empty');
		}

		if (data.length > 500) {
			throw new BadRequestError('Cannot import more than 500 variables at once');
		}

		if (validateOnly) {
			// Validate without actually importing
			const errors = [];
			for (const item of data) {
				try {
					if (!item.key || !item.type) {
						errors.push(`Invalid variable: missing key or type`);
					}
				} catch (error) {
					errors.push(`Validation error: ${error.message}`);
				}
			}

			return {
				success: true,
				validation: {
					valid: errors.length === 0,
					errors,
					totalItems: data.length,
				},
			};
		}

		const result = await this.variablesService.importVariables(data, overwrite);

		this.logger.info(`Variables imported`, {
			userId: req.user.id,
			imported: result.imported,
			skipped: result.skipped,
			errors: result.errors.length,
			overwrite,
		});

		return {
			success: true,
			data: result,
		};
	}

	/**
	 * Get variable usage statistics
	 */
	@Get('/:id/usage')
	@GlobalScope('variable:read')
	async getVariableUsage(req: AuthenticatedRequest<{ id: string }>) {
		const { id } = req.params;

		const variable = await this.variablesService.getVariable(id);
		if (!variable) {
			throw new BadRequestError('Variable not found');
		}

		const usage = await this.variablesService.getVariableUsage(variable.key);

		return {
			success: true,
			data: {
				variable: variable.key,
				usage,
			},
		};
	}

	/**
	 * Clean up unused variables
	 */
	@Post('/cleanup')
	@GlobalScope('variable:delete')
	async cleanupVariables(req: AuthenticatedRequest) {
		const removedCount = await this.variablesService.cleanupUnusedVariables();

		this.logger.info(`Variable cleanup completed`, {
			userId: req.user.id,
			removedCount,
		});

		return {
			success: true,
			data: {
				removedCount,
				message: `Removed ${removedCount} unused variables`,
			},
		};
	}

	/**
	 * Get variable statistics
	 */
	@Get('/stats/overview')
	@GlobalScope('variable:list')
	async getVariableStats() {
		const { variables, total } = await this.variablesService.getVariables({ limit: 1000 });

		const stats = {
			total,
			byType: {} as Record<string, number>,
			encrypted: 0,
			withTags: 0,
			averageKeyLength: 0,
			averageValueLength: 0,
		};

		let totalKeyLength = 0;
		let totalValueLength = 0;

		variables.forEach(variable => {
			// Count by type
			stats.byType[variable.type] = (stats.byType[variable.type] || 0) + 1;

			// Count encrypted
			if (variable.isEncrypted) {
				stats.encrypted++;
			}

			// Count with tags
			if (variable.tags && variable.tags.length > 0) {
				stats.withTags++;
			}

			// Calculate lengths
			totalKeyLength += variable.key.length;
			totalValueLength += variable.value?.length || 0;
		});

		if (total > 0) {
			stats.averageKeyLength = Math.round(totalKeyLength / total);
			stats.averageValueLength = Math.round(totalValueLength / total);
		}

		return {
			success: true,
			data: stats,
		};
	}

	/**
	 * Convert data to CSV format
	 */
	private convertToCSV(data: any[]): string {
		if (data.length === 0) return '';

		const headers = ['key', 'type', 'value', 'description', 'tags', 'createdAt', 'updatedAt'];
		const csvRows = [headers.join(',')];

		data.forEach(item => {
			const row = headers.map(header => {
				let value = item[header];
				if (Array.isArray(value)) {
					value = value.join(';');
				}
				if (value === undefined || value === null) {
					value = '';
				}
				// Escape commas and quotes
				if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
					value = `"${value.replace(/"/g, '""')}"`;
				}
				return value;
			});
			csvRows.push(row.join(','));
		});

		return csvRows.join('\n');
	}
}