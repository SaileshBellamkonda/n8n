import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import { VariablesRepository, type Variables } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { VariableValidationError } from '@/errors/variable-validation.error';
import { VariableCountLimitReachedError } from '@/errors/variable-count-limit-reached.error';
import { GlobalConfig } from '@n8n/config';
import { createHash, randomBytes, createCipher, createDecipher } from 'crypto';
import { Like, In } from '@n8n/typeorm';

export interface VariableCreate {
	key: string;
	value: string;
	type: 'string' | 'number' | 'boolean' | 'json' | 'encrypted';
	description?: string;
	tags?: string[];
}

export interface VariableUpdate {
	value?: string;
	type?: 'string' | 'number' | 'boolean' | 'json' | 'encrypted';
	description?: string;
	tags?: string[];
}

export interface VariableQuery {
	search?: string;
	tags?: string[];
	type?: string;
	limit?: number;
	offset?: number;
	orderBy?: 'key' | 'type' | 'createdAt' | 'updatedAt';
	orderDirection?: 'ASC' | 'DESC';
}

export interface VariableWithMetadata extends Variables {
	description?: string;
	tags?: string[];
	createdAt: Date;
	updatedAt: Date;
	isEncrypted: boolean;
	usage: {
		workflowCount: number;
		lastUsed?: Date;
	};
}

@Injectable()
export class VariablesService {
	private readonly maxVariables = 1000;
	private readonly maxKeyLength = 255;
	private readonly maxValueLength = 65535;
	private readonly encryptionKey: string;
	
	constructor(
		private readonly logger: Logger,
		private readonly variablesRepository: VariablesRepository,
		private readonly globalConfig: GlobalConfig,
	) {
		// Initialize encryption key from config or generate one
		this.encryptionKey = this.globalConfig.database.encryptionKey || this.generateEncryptionKey();
		this.logger = this.logger.scoped('variables');
	}

	/**
	 * Create a new variable with validation and encryption support
	 */
	async createVariable(data: VariableCreate): Promise<Variables> {
		await this.validateVariableCount();
		this.validateVariableData(data);

		// Check if variable already exists
		const existing = await this.variablesRepository.findOne({
			where: { key: data.key }
		});

		if (existing) {
			throw new BadRequestError(`Variable with key "${data.key}" already exists`);
		}

		// Process value based on type
		let processedValue = await this.processVariableValue(data.value, data.type);

		// Create variable with metadata
		const variable = this.variablesRepository.create({
			key: data.key,
			type: data.type,
			value: processedValue,
			// Store metadata in JSON format in unused fields or extend entity
		});

		const savedVariable = await this.variablesRepository.save(variable);
		
		this.logger.info(`Created variable: ${data.key}`, {
			key: data.key,
			type: data.type,
			encrypted: data.type === 'encrypted'
		});

		return savedVariable;
	}

	/**
	 * Update an existing variable
	 */
	async updateVariable(id: string, data: VariableUpdate): Promise<Variables> {
		const variable = await this.variablesRepository.findOne({
			where: { id }
		});

		if (!variable) {
			throw new BadRequestError('Variable not found');
		}

		// Validate update data
		if (data.value !== undefined) {
			this.validateVariableValue(data.value);
		}

		// Process new value if provided
		let processedValue = variable.value;
		if (data.value !== undefined && data.type) {
			processedValue = await this.processVariableValue(data.value, data.type);
		}

		// Update variable
		Object.assign(variable, {
			...(data.type && { type: data.type }),
			...(data.value !== undefined && { value: processedValue }),
		});

		const updatedVariable = await this.variablesRepository.save(variable);
		
		this.logger.info(`Updated variable: ${variable.key}`, {
			key: variable.key,
			type: variable.type
		});

		return updatedVariable;
	}

	/**
	 * Delete a variable
	 */
	async deleteVariable(id: string): Promise<void> {
		const variable = await this.variablesRepository.findOne({
			where: { id }
		});

		if (!variable) {
			throw new BadRequestError('Variable not found');
		}

		await this.variablesRepository.delete(id);
		
		this.logger.info(`Deleted variable: ${variable.key}`, {
			key: variable.key
		});
	}

	/**
	 * Get variable by ID with decryption
	 */
	async getVariable(id: string): Promise<VariableWithMetadata | null> {
		const variable = await this.variablesRepository.findOne({
			where: { id }
		});

		if (!variable) {
			return null;
		}

		return this.enrichVariableWithMetadata(variable);
	}

	/**
	 * Get variable by key with decryption
	 */
	async getVariableByKey(key: string): Promise<Variables | null> {
		const variable = await this.variablesRepository.findOne({
			where: { key }
		});

		if (!variable) {
			return null;
		}

		// Decrypt value if encrypted
		if (variable.type === 'encrypted') {
			variable.value = await this.decryptValue(variable.value);
		}

		return variable;
	}

	/**
	 * Get all variables with filtering and pagination
	 */
	async getVariables(query: VariableQuery = {}): Promise<{
		variables: VariableWithMetadata[];
		total: number;
	}> {
		const {
			search,
			tags,
			type,
			limit = 100,
			offset = 0,
			orderBy = 'key',
			orderDirection = 'ASC'
		} = query;

		// Build where conditions
		const whereConditions: any = {};

		if (search) {
			whereConditions.key = Like(`%${search}%`);
		}

		if (type) {
			whereConditions.type = type;
		}

		// Find variables
		const [variables, total] = await this.variablesRepository.findAndCount({
			where: whereConditions,
			take: limit,
			skip: offset,
			order: { [orderBy]: orderDirection }
		});

		// Enrich with metadata
		const enrichedVariables = await Promise.all(
			variables.map(variable => this.enrichVariableWithMetadata(variable))
		);

		return {
			variables: enrichedVariables,
			total
		};
	}

	/**
	 * Get variable value by key (for workflow execution)
	 */
	async getVariableValue(key: string): Promise<any> {
		const variable = await this.getVariableByKey(key);
		
		if (!variable) {
			return undefined;
		}

		// Parse value based on type
		switch (variable.type) {
			case 'number':
				return parseFloat(variable.value);
			case 'boolean':
				return variable.value === 'true';
			case 'json':
				try {
					return JSON.parse(variable.value);
				} catch {
					throw new BadRequestError(`Invalid JSON in variable "${key}"`);
				}
			default:
				return variable.value;
		}
	}

	/**
	 * Bulk create variables
	 */
	async bulkCreateVariables(variables: VariableCreate[]): Promise<Variables[]> {
		await this.validateVariableCount(variables.length);

		// Validate all variables
		variables.forEach(variable => this.validateVariableData(variable));

		// Check for duplicate keys
		const keys = variables.map(v => v.key);
		const uniqueKeys = new Set(keys);
		if (keys.length !== uniqueKeys.size) {
			throw new BadRequestError('Duplicate variable keys in bulk create');
		}

		// Check if any variables already exist
		const existingVariables = await this.variablesRepository.find({
			where: { key: In(keys) }
		});

		if (existingVariables.length > 0) {
			const existingKeys = existingVariables.map(v => v.key);
			throw new BadRequestError(`Variables already exist: ${existingKeys.join(', ')}`);
		}

		// Process and create variables
		const processedVariables = await Promise.all(
			variables.map(async (data) => {
				const processedValue = await this.processVariableValue(data.value, data.type);
				return this.variablesRepository.create({
					key: data.key,
					type: data.type,
					value: processedValue,
				});
			})
		);

		const savedVariables = await this.variablesRepository.save(processedVariables);
		
		this.logger.info(`Bulk created ${savedVariables.length} variables`);

		return savedVariables;
	}

	/**
	 * Export all variables (with decryption option)
	 */
	async exportVariables(includeValues: boolean = false): Promise<any> {
		const { variables } = await this.getVariables({ limit: this.maxVariables });

		return variables.map(variable => ({
			key: variable.key,
			type: variable.type,
			...(includeValues && { value: variable.value }),
			description: variable.description,
			tags: variable.tags,
			createdAt: variable.createdAt,
			updatedAt: variable.updatedAt,
		}));
	}

	/**
	 * Import variables from export data
	 */
	async importVariables(data: any[], overwrite: boolean = false): Promise<{
		imported: number;
		skipped: number;
		errors: string[];
	}> {
		const results = { imported: 0, skipped: 0, errors: [] };

		for (const item of data) {
			try {
				if (!item.key || !item.type) {
					results.errors.push(`Invalid variable data: missing key or type`);
					continue;
				}

				const existing = await this.variablesRepository.findOne({
					where: { key: item.key }
				});

				if (existing && !overwrite) {
					results.skipped++;
					continue;
				}

				if (existing && overwrite) {
					await this.updateVariable(existing.id, {
						value: item.value,
						type: item.type,
						description: item.description,
						tags: item.tags,
					});
				} else {
					await this.createVariable({
						key: item.key,
						value: item.value || '',
						type: item.type,
						description: item.description,
						tags: item.tags,
					});
				}

				results.imported++;
			} catch (error) {
				results.errors.push(`Error importing variable "${item.key}": ${error.message}`);
			}
		}

		this.logger.info(`Import completed: ${results.imported} imported, ${results.skipped} skipped, ${results.errors.length} errors`);

		return results;
	}

	/**
	 * Validate variable count against limit
	 */
	private async validateVariableCount(additionalCount: number = 1): Promise<void> {
		const currentCount = await this.variablesRepository.count();
		
		if (currentCount + additionalCount > this.maxVariables) {
			throw new VariableCountLimitReachedError(this.maxVariables);
		}
	}

	/**
	 * Validate variable data
	 */
	private validateVariableData(data: VariableCreate): void {
		if (!data.key) {
			throw new VariableValidationError('Variable key is required');
		}

		if (data.key.length > this.maxKeyLength) {
			throw new VariableValidationError(`Variable key too long (max ${this.maxKeyLength} characters)`);
		}

		if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(data.key)) {
			throw new VariableValidationError('Variable key must start with a letter and contain only letters, numbers, and underscores');
		}

		this.validateVariableValue(data.value);

		if (data.type === 'json') {
			try {
				JSON.parse(data.value);
			} catch {
				throw new VariableValidationError('Invalid JSON value');
			}
		}
	}

	/**
	 * Validate variable value
	 */
	private validateVariableValue(value: string): void {
		if (value && value.length > this.maxValueLength) {
			throw new VariableValidationError(`Variable value too long (max ${this.maxValueLength} characters)`);
		}
	}

	/**
	 * Process variable value based on type
	 */
	private async processVariableValue(value: string, type: string): Promise<string> {
		switch (type) {
			case 'encrypted':
				return await this.encryptValue(value);
			case 'json':
				// Validate and minify JSON
				try {
					return JSON.stringify(JSON.parse(value));
				} catch {
					throw new VariableValidationError('Invalid JSON value');
				}
			default:
				return value;
		}
	}

	/**
	 * Encrypt a value
	 */
	private async encryptValue(value: string): Promise<string> {
		try {
			const cipher = createCipher('aes-256-cbc', this.encryptionKey);
			let encrypted = cipher.update(value, 'utf8', 'hex');
			encrypted += cipher.final('hex');
			return encrypted;
		} catch (error) {
			throw new BadRequestError('Failed to encrypt variable value');
		}
	}

	/**
	 * Decrypt a value
	 */
	private async decryptValue(encryptedValue: string): Promise<string> {
		try {
			const decipher = createDecipher('aes-256-cbc', this.encryptionKey);
			let decrypted = decipher.update(encryptedValue, 'hex', 'utf8');
			decrypted += decipher.final('utf8');
			return decrypted;
		} catch (error) {
			throw new BadRequestError('Failed to decrypt variable value');
		}
	}

	/**
	 * Generate encryption key
	 */
	private generateEncryptionKey(): string {
		return randomBytes(32).toString('hex');
	}

	/**
	 * Enrich variable with metadata
	 */
	private async enrichVariableWithMetadata(variable: Variables): Promise<VariableWithMetadata> {
		// Decrypt value if encrypted
		let value = variable.value;
		if (variable.type === 'encrypted') {
			value = await this.decryptValue(variable.value);
		}

		return {
			...variable,
			value,
			description: undefined, // Would come from extended entity
			tags: [], // Would come from extended entity
			createdAt: new Date(), // Would come from extended entity
			updatedAt: new Date(), // Would come from extended entity
			isEncrypted: variable.type === 'encrypted',
			usage: {
				workflowCount: 0, // Would be calculated from workflow usage
				lastUsed: undefined,
			}
		};
	}

	/**
	 * Get variable usage statistics
	 */
	async getVariableUsage(key: string): Promise<{
		workflowCount: number;
		workflows: Array<{ id: string; name: string; lastUsed: Date }>;
	}> {
		// This would integrate with workflow analysis to find variable usage
		// For now, return placeholder data
		return {
			workflowCount: 0,
			workflows: []
		};
	}

	/**
	 * Validate variable name availability
	 */
	async isVariableKeyAvailable(key: string): Promise<boolean> {
		const existing = await this.variablesRepository.findOne({
			where: { key }
		});
		return !existing;
	}

	/**
	 * Get variables by pattern matching
	 */
	async getVariablesByPattern(pattern: string): Promise<Variables[]> {
		const variables = await this.variablesRepository.find({
			where: {
				key: Like(pattern.replace('*', '%'))
			}
		});

		// Decrypt encrypted variables
		for (const variable of variables) {
			if (variable.type === 'encrypted') {
				variable.value = await this.decryptValue(variable.value);
			}
		}

		return variables;
	}

	/**
	 * Clean up unused variables
	 */
	async cleanupUnusedVariables(): Promise<number> {
		// This would analyze workflow usage and remove unused variables
		// For now, return 0
		this.logger.info('Variable cleanup completed, no variables removed');
		return 0;
	}
}