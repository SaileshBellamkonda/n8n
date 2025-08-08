// Community Edition External Secrets Service
// Simple local secrets management for community edition

import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ExternalSecret {
	id: string;
	name: string;
	value: string;
	provider: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface SecretProvider {
	type: 'local' | 'env' | 'file';
	name: string;
	enabled: boolean;
	config: Record<string, any>;
}

export interface LocalSecretConfig {
	secretsPath: string;
	encryption: boolean;
	encryptionKey?: string;
}

@Injectable()
export class CommunityExternalSecretsService {
	private providers: Map<string, SecretProvider> = new Map();
	private localConfig: LocalSecretConfig = {
		secretsPath: process.env.N8N_SECRETS_PATH || './secrets',
		encryption: false,
	};

	constructor(private readonly logger: Logger) {
		this.initializeProviders();
	}

	/**
	 * Initialize default providers for community edition
	 */
	private initializeProviders(): void {
		// Local file-based secrets
		this.providers.set('local', {
			type: 'local',
			name: 'Local Secrets',
			enabled: true,
			config: this.localConfig,
		});

		// Environment variables
		this.providers.set('env', {
			type: 'env',
			name: 'Environment Variables',
			enabled: true,
			config: {},
		});

		this.logger.info('Initialized community external secrets providers');
	}

	/**
	 * Get all available providers
	 */
	getProviders(): SecretProvider[] {
		return Array.from(this.providers.values());
	}

	/**
	 * Get secret value from provider
	 */
	async getSecret(secretName: string, provider: string = 'env'): Promise<string | null> {
		switch (provider) {
			case 'env':
				return process.env[secretName] || null;
			
			case 'local':
				return await this.getLocalSecret(secretName);
			
			default:
				throw new BadRequestError(`Provider '${provider}' is not available in community edition`);
		}
	}

	/**
	 * Set secret value (local provider only)
	 */
	async setSecret(secretName: string, secretValue: string, provider: string = 'local'): Promise<void> {
		if (provider === 'local') {
			await this.setLocalSecret(secretName, secretValue);
		} else {
			throw new BadRequestError(`Setting secrets for provider '${provider}' is not available in community edition`);
		}
	}

	/**
	 * List all secrets from a provider
	 */
	async listSecrets(provider: string = 'env'): Promise<string[]> {
		switch (provider) {
			case 'env':
				return Object.keys(process.env).filter(key => 
					key.startsWith('N8N_') || key.startsWith('SECRET_')
				);
			
			case 'local':
				return await this.listLocalSecrets();
			
			default:
				throw new BadRequestError(`Provider '${provider}' is not available in community edition`);
		}
	}

	/**
	 * Delete secret (local provider only)
	 */
	async deleteSecret(secretName: string, provider: string = 'local'): Promise<void> {
		if (provider === 'local') {
			await this.deleteLocalSecret(secretName);
		} else {
			throw new BadRequestError(`Deleting secrets for provider '${provider}' is not available in community edition`);
		}
	}

	/**
	 * Test provider connection
	 */
	async testProvider(providerName: string): Promise<boolean> {
		const provider = this.providers.get(providerName);
		if (!provider) {
			return false;
		}

		try {
			switch (provider.type) {
				case 'env':
					return true; // Environment variables are always available
				
				case 'local':
					await fs.access(this.localConfig.secretsPath);
					return true;
				
				default:
					return false;
			}
		} catch (error) {
			this.logger.error(`Provider test failed for ${providerName}:`, error);
			return false;
		}
	}

	/**
	 * Get local secret from file system
	 */
	private async getLocalSecret(secretName: string): Promise<string | null> {
		try {
			const secretPath = path.join(this.localConfig.secretsPath, `${secretName}.txt`);
			const secretValue = await fs.readFile(secretPath, 'utf-8');
			return secretValue.trim();
		} catch (error) {
			if ((error as any).code === 'ENOENT') {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Set local secret to file system
	 */
	private async setLocalSecret(secretName: string, secretValue: string): Promise<void> {
		try {
			await fs.mkdir(this.localConfig.secretsPath, { recursive: true });
			const secretPath = path.join(this.localConfig.secretsPath, `${secretName}.txt`);
			await fs.writeFile(secretPath, secretValue, 'utf-8');
			this.logger.debug(`Saved local secret: ${secretName}`);
		} catch (error) {
			this.logger.error(`Failed to save local secret ${secretName}:`, error);
			throw new BadRequestError(`Failed to save secret: ${error.message}`);
		}
	}

	/**
	 * List local secrets from file system
	 */
	private async listLocalSecrets(): Promise<string[]> {
		try {
			const files = await fs.readdir(this.localConfig.secretsPath);
			return files
				.filter(file => file.endsWith('.txt'))
				.map(file => file.replace('.txt', ''));
		} catch (error) {
			if ((error as any).code === 'ENOENT') {
				return [];
			}
			throw error;
		}
	}

	/**
	 * Delete local secret from file system
	 */
	private async deleteLocalSecret(secretName: string): Promise<void> {
		try {
			const secretPath = path.join(this.localConfig.secretsPath, `${secretName}.txt`);
			await fs.unlink(secretPath);
			this.logger.debug(`Deleted local secret: ${secretName}`);
		} catch (error) {
			if ((error as any).code !== 'ENOENT') {
				throw new BadRequestError(`Failed to delete secret: ${error.message}`);
			}
		}
	}
}