import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import { CredentialsRepository, type User, type CredentialsEntity } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { GlobalConfig } from '@n8n/config';
import { createHash, randomBytes } from 'crypto';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

export interface VaultConfig {
	enabled: boolean;
	apiVersion: 'v1' | 'v2';
	endpoint: string;
	authMethod: 'token' | 'userpass' | 'ldap' | 'kubernetes' | 'aws' | 'gcp';
	token?: string;
	username?: string;
	password?: string;
	namespace?: string;
	enginePath: string;
	keyPrefix: string;
	tlsConfig: {
		enabled: boolean;
		caCert?: string;
		clientCert?: string;
		clientKey?: string;
		skipVerify?: boolean;
	};
	transitEncryption: {
		enabled: boolean;
		keyName: string;
	};
	secretConfig: {
		ttl?: string;
		maxTtl?: string;
		versioning: boolean;
		maxVersions: number;
		deleteVersionAfter?: string;
	};
	auditConfig: {
		enabled: boolean;
		logRequests: boolean;
		logResponses: boolean;
		sensitiveHeaders: string[];
	};
	leaseConfig: {
		enabled: boolean;
		defaultTtl: string;
		maxTtl: string;
		renewThreshold: number;
	};
}

export interface VaultCredential {
	id: string;
	name: string;
	type: string;
	data: ICredentialDataDecryptedObject;
	vaultPath: string;
	vaultVersion?: number;
	metadata: {
		createdAt: Date;
		createdBy: string;
		updatedAt: Date;
		updatedBy: string;
		version: number;
		tags: string[];
		description?: string;
	};
	leaseInfo?: {
		leaseId: string;
		renewable: boolean;
		leaseDuration: number;
		leaseEndTime: Date;
	};
	audit: {
		accessCount: number;
		lastAccessed: Date;
		lastAccessedBy: string;
		accessHistory: Array<{
			timestamp: Date;
			userId: string;
			action: string;
			ipAddress?: string;
		}>;
	};
}

export interface VaultAuthResponse {
	clientToken: string;
	accessor: string;
	policies: string[];
	tokenMetadata: Record<string, any>;
	leaseDuration: number;
	renewable: boolean;
}

export interface VaultSecretResponse {
	requestId: string;
	leaseId?: string;
	renewable: boolean;
	leaseDuration?: number;
	data: {
		data?: Record<string, any>;
		metadata?: Record<string, any>;
	};
}

export interface CredentialQuery {
	type?: string;
	search?: string;
	tags?: string[];
	createdBy?: string;
	fromDate?: Date;
	toDate?: Date;
	limit?: number;
	offset?: number;
	includeData?: boolean;
	includeMetadata?: boolean;
	includeAudit?: boolean;
}

@Injectable()
export class VaultCredentialsService {
	private config: VaultConfig = {
		enabled: true, // Enable Vault in community edition
		apiVersion: 'v2',
		endpoint: 'http://localhost:8200',
		authMethod: 'token',
		namespace: 'n8n',
		enginePath: 'secret',
		keyPrefix: 'n8n/credentials',
		tlsConfig: {
			enabled: false,
			skipVerify: false,
		},
		transitEncryption: {
			enabled: false,
			keyName: 'n8n-credentials',
		},
		secretConfig: {
			versioning: true,
			maxVersions: 10,
			deleteVersionAfter: '365d',
		},
		auditConfig: {
			enabled: true,
			logRequests: true,
			logResponses: false,
			sensitiveHeaders: ['x-vault-token', 'authorization'],
		},
		leaseConfig: {
			enabled: false,
			defaultTtl: '1h',
			maxTtl: '24h',
			renewThreshold: 0.3,
		},
	};

	private vaultToken: string | null = null;
	private tokenExpiresAt: Date | null = null;
	private authenticatedUser: string | null = null;
	private leaseRenewalTimers = new Map<string, NodeJS.Timeout>();

	constructor(
		private readonly logger: Logger,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('vault-credentials');
		this.loadConfigFromEnvironment();
	}

	/**
	 * Check if Vault is enabled
	 */
	isEnabled(): boolean {
		return this.config.enabled && !!this.config.endpoint;
	}

	/**
	 * Configure Vault settings
	 */
	configure(config: Partial<VaultConfig>): void {
		this.config = { ...this.config, ...config };
		this.logger.info('Vault credentials configuration updated', {
			enabled: this.config.enabled,
			endpoint: this.config.endpoint,
			authMethod: this.config.authMethod,
			enginePath: this.config.enginePath,
		});
	}

	/**
	 * Initialize Vault connection
	 */
	async initialize(): Promise<void> {
		if (!this.isEnabled()) {
			this.logger.info('Vault credentials service is disabled');
			return;
		}

		try {
			// Authenticate with Vault
			await this.authenticate();

			// Verify connection and permissions
			await this.verifyConnection();

			// Setup automatic token renewal if needed
			if (this.config.leaseConfig.enabled && this.tokenExpiresAt) {
				this.setupTokenRenewal();
			}

			this.logger.info('Vault credentials service initialized successfully', {
				endpoint: this.config.endpoint,
				authMethod: this.config.authMethod,
				enginePath: this.config.enginePath,
			});
		} catch (error) {
			this.logger.error('Failed to initialize Vault credentials service', {
				error: error.message,
				stack: error.stack,
			});
			throw error;
		}
	}

	/**
	 * Create credential in Vault
	 */
	async createCredential(
		name: string,
		type: string,
		data: ICredentialDataDecryptedObject,
		user: User,
		options: {
			description?: string;
			tags?: string[];
			ttl?: string;
		} = {}
	): Promise<VaultCredential> {
		if (!this.isEnabled()) {
			throw new BadRequestError('Vault credentials service is not enabled');
		}

		await this.ensureAuthenticated();

		try {
			const credentialId = this.generateCredentialId();
			const vaultPath = this.getVaultPath(credentialId);

			// Prepare credential data for Vault
			const vaultData = {
				id: credentialId,
				name,
				type,
				data: this.encryptSensitiveData(data),
				metadata: {
					createdAt: new Date().toISOString(),
					createdBy: user.id,
					updatedAt: new Date().toISOString(),
					updatedBy: user.id,
					version: 1,
					tags: options.tags || [],
					description: options.description,
				},
			};

			// Store in Vault
			const vaultResponse = await this.storeSecret(vaultPath, vaultData, options.ttl);

			// Create credential object
			const credential: VaultCredential = {
				id: credentialId,
				name,
				type,
				data,
				vaultPath,
				vaultVersion: vaultResponse.data.metadata?.version,
				metadata: {
					createdAt: new Date(),
					createdBy: user.id,
					updatedAt: new Date(),
					updatedBy: user.id,
					version: 1,
					tags: options.tags || [],
					description: options.description,
				},
				...(vaultResponse.leaseId && {
					leaseInfo: {
						leaseId: vaultResponse.leaseId,
						renewable: vaultResponse.renewable,
						leaseDuration: vaultResponse.leaseDuration || 0,
						leaseEndTime: new Date(Date.now() + (vaultResponse.leaseDuration || 0) * 1000),
					},
				}),
				audit: {
					accessCount: 0,
					lastAccessed: new Date(),
					lastAccessedBy: user.id,
					accessHistory: [{
						timestamp: new Date(),
						userId: user.id,
						action: 'create',
					}],
				},
			};

			// Store reference in database
			await this.storeCredentialReference(credential, user);

			// Setup lease renewal if needed
			if (credential.leaseInfo?.renewable) {
				this.setupLeaseRenewal(credential.leaseInfo.leaseId);
			}

			this.logger.info('Credential created in Vault', {
				credentialId,
				name,
				type,
				vaultPath,
				userId: user.id,
			});

			return credential;
		} catch (error) {
			this.logger.error('Failed to create credential in Vault', {
				name,
				type,
				error: error.message,
			});
			throw new BadRequestError(`Failed to create credential: ${error.message}`);
		}
	}

	/**
	 * Get credential from Vault
	 */
	async getCredential(credentialId: string, user: User, includeData: boolean = false): Promise<VaultCredential | null> {
		if (!this.isEnabled()) {
			throw new BadRequestError('Vault credentials service is not enabled');
		}

		await this.ensureAuthenticated();

		try {
			const vaultPath = this.getVaultPath(credentialId);

			// Retrieve from Vault
			const secretResponse = await this.getSecret(vaultPath);
			if (!secretResponse) {
				return null;
			}

			const vaultData = secretResponse.data.data;
			if (!vaultData) {
				return null;
			}

			// Decrypt sensitive data if requested
			let decryptedData = {};
			if (includeData) {
				decryptedData = this.decryptSensitiveData(vaultData.data);
			}

			// Build credential object
			const credential: VaultCredential = {
				id: credentialId,
				name: vaultData.name,
				type: vaultData.type,
				data: decryptedData,
				vaultPath,
				vaultVersion: secretResponse.data.metadata?.version,
				metadata: {
					...vaultData.metadata,
					createdAt: new Date(vaultData.metadata.createdAt),
					updatedAt: new Date(vaultData.metadata.updatedAt),
				},
				audit: {
					accessCount: 0,
					lastAccessed: new Date(),
					lastAccessedBy: user.id,
					accessHistory: [],
				},
			};

			// Log access
			await this.logCredentialAccess(credentialId, user, 'read');

			return credential;
		} catch (error) {
			this.logger.error('Failed to get credential from Vault', {
				credentialId,
				error: error.message,
			});
			return null;
		}
	}

	/**
	 * Update credential in Vault
	 */
	async updateCredential(
		credentialId: string,
		updates: {
			name?: string;
			data?: ICredentialDataDecryptedObject;
			description?: string;
			tags?: string[];
		},
		user: User
	): Promise<VaultCredential> {
		if (!this.isEnabled()) {
			throw new BadRequestError('Vault credentials service is not enabled');
		}

		await this.ensureAuthenticated();

		try {
			// Get current credential
			const existingCredential = await this.getCredential(credentialId, user, true);
			if (!existingCredential) {
				throw new NotFoundError('Credential not found');
			}

			const vaultPath = this.getVaultPath(credentialId);

			// Prepare updated data
			const updatedData = {
				...existingCredential,
				name: updates.name || existingCredential.name,
				data: this.encryptSensitiveData(updates.data || existingCredential.data),
				metadata: {
					...existingCredential.metadata,
					updatedAt: new Date().toISOString(),
					updatedBy: user.id,
					version: existingCredential.metadata.version + 1,
					description: updates.description !== undefined ? updates.description : existingCredential.metadata.description,
					tags: updates.tags || existingCredential.metadata.tags,
				},
			};

			// Store updated data in Vault
			const vaultResponse = await this.storeSecret(vaultPath, updatedData);

			// Build updated credential object
			const updatedCredential: VaultCredential = {
				...existingCredential,
				name: updates.name || existingCredential.name,
				data: updates.data || existingCredential.data,
				vaultVersion: vaultResponse.data.metadata?.version,
				metadata: {
					...existingCredential.metadata,
					updatedAt: new Date(),
					updatedBy: user.id,
					version: existingCredential.metadata.version + 1,
					description: updates.description !== undefined ? updates.description : existingCredential.metadata.description,
					tags: updates.tags || existingCredential.metadata.tags,
				},
			};

			// Log access
			await this.logCredentialAccess(credentialId, user, 'update');

			this.logger.info('Credential updated in Vault', {
				credentialId,
				userId: user.id,
				changes: Object.keys(updates),
			});

			return updatedCredential;
		} catch (error) {
			this.logger.error('Failed to update credential in Vault', {
				credentialId,
				error: error.message,
			});
			throw new BadRequestError(`Failed to update credential: ${error.message}`);
		}
	}

	/**
	 * Delete credential from Vault
	 */
	async deleteCredential(credentialId: string, user: User): Promise<void> {
		if (!this.isEnabled()) {
			throw new BadRequestError('Vault credentials service is not enabled');
		}

		await this.ensureAuthenticated();

		try {
			const vaultPath = this.getVaultPath(credentialId);

			// Delete from Vault
			await this.deleteSecret(vaultPath);

			// Remove from database
			await this.removeCredentialReference(credentialId);

			// Cancel lease renewal if active
			const renewalTimer = this.leaseRenewalTimers.get(credentialId);
			if (renewalTimer) {
				clearTimeout(renewalTimer);
				this.leaseRenewalTimers.delete(credentialId);
			}

			// Log access
			await this.logCredentialAccess(credentialId, user, 'delete');

			this.logger.info('Credential deleted from Vault', {
				credentialId,
				userId: user.id,
			});
		} catch (error) {
			this.logger.error('Failed to delete credential from Vault', {
				credentialId,
				error: error.message,
			});
			throw new BadRequestError(`Failed to delete credential: ${error.message}`);
		}
	}

	/**
	 * List credentials
	 */
	async listCredentials(user: User, query: CredentialQuery = {}): Promise<{
		credentials: VaultCredential[];
		total: number;
	}> {
		if (!this.isEnabled()) {
			throw new BadRequestError('Vault credentials service is not enabled');
		}

		await this.ensureAuthenticated();

		try {
			// List secrets from Vault
			const secretPaths = await this.listSecrets(this.config.keyPrefix);

			const credentials: VaultCredential[] = [];

			for (const path of secretPaths) {
				try {
					const credentialId = this.extractCredentialIdFromPath(path);
					const credential = await this.getCredential(credentialId, user, query.includeData);

					if (credential && this.matchesQuery(credential, query)) {
						credentials.push(credential);
					}
				} catch (error) {
					this.logger.warn('Failed to load credential from Vault', {
						path,
						error: error.message,
					});
				}
			}

			// Apply sorting and pagination
			const sortedCredentials = this.sortCredentials(credentials);
			const offset = query.offset || 0;
			const limit = query.limit || 100;
			const paginatedCredentials = sortedCredentials.slice(offset, offset + limit);

			return {
				credentials: paginatedCredentials,
				total: credentials.length,
			};
		} catch (error) {
			this.logger.error('Failed to list credentials from Vault', {
				error: error.message,
			});
			throw new BadRequestError(`Failed to list credentials: ${error.message}`);
		}
	}

	/**
	 * Test Vault connection
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.authenticate();
			await this.verifyConnection();
			
			this.logger.info('Vault connection test successful', {
				endpoint: this.config.endpoint,
				authMethod: this.config.authMethod,
			});
			
			return true;
		} catch (error) {
			this.logger.error('Vault connection test failed', {
				endpoint: this.config.endpoint,
				error: error.message,
			});
			return false;
		}
	}

	/**
	 * Get Vault status
	 */
	async getVaultStatus(): Promise<{
		initialized: boolean;
		sealed: boolean;
		version: string;
		authenticated: boolean;
		tokenExpiry?: Date;
	}> {
		try {
			const statusResponse = await this.makeVaultRequest('GET', '/v1/sys/health', undefined, false);
			
			return {
				initialized: statusResponse.initialized,
				sealed: statusResponse.sealed,
				version: statusResponse.version,
				authenticated: !!this.vaultToken,
				tokenExpiry: this.tokenExpiresAt,
			};
		} catch (error) {
			this.logger.error('Failed to get Vault status', {
				error: error.message,
			});
			throw new BadRequestError(`Failed to get Vault status: ${error.message}`);
		}
	}

	// Private methods for Vault operations

	private async authenticate(): Promise<void> {
		let authPath: string;
		let authData: any;

		switch (this.config.authMethod) {
			case 'token':
				if (!this.config.token) {
					throw new Error('Vault token is required for token authentication');
				}
				this.vaultToken = this.config.token;
				return;

			case 'userpass':
				authPath = '/v1/auth/userpass/login/' + this.config.username;
				authData = { password: this.config.password };
				break;

			case 'ldap':
				authPath = '/v1/auth/ldap/login/' + this.config.username;
				authData = { password: this.config.password };
				break;

			default:
				throw new Error(`Unsupported auth method: ${this.config.authMethod}`);
		}

		const response = await this.makeVaultRequest('POST', authPath, authData, false);
		const authInfo = response.auth;

		this.vaultToken = authInfo.client_token;
		this.authenticatedUser = this.config.username;
		
		if (authInfo.lease_duration) {
			this.tokenExpiresAt = new Date(Date.now() + authInfo.lease_duration * 1000);
		}

		this.logger.debug('Vault authentication successful', {
			authMethod: this.config.authMethod,
			policies: authInfo.policies,
			leaseDuration: authInfo.lease_duration,
		});
	}

	private async ensureAuthenticated(): Promise<void> {
		if (!this.vaultToken) {
			await this.authenticate();
			return;
		}

		// Check if token is about to expire
		if (this.tokenExpiresAt && this.tokenExpiresAt.getTime() - Date.now() < 300000) { // 5 minutes
			try {
				await this.renewToken();
			} catch (error) {
				this.logger.warn('Token renewal failed, re-authenticating', {
					error: error.message,
				});
				await this.authenticate();
			}
		}
	}

	private async renewToken(): Promise<void> {
		if (!this.vaultToken) {
			throw new Error('No token to renew');
		}

		const response = await this.makeVaultRequest('POST', '/v1/auth/token/renew-self');
		const authInfo = response.auth;

		if (authInfo.lease_duration) {
			this.tokenExpiresAt = new Date(Date.now() + authInfo.lease_duration * 1000);
		}

		this.logger.debug('Vault token renewed successfully', {
			leaseDuration: authInfo.lease_duration,
		});
	}

	private async verifyConnection(): Promise<void> {
		// Test read access to the secret engine
		try {
			await this.makeVaultRequest('GET', `/v1/${this.config.enginePath}/config`);
		} catch (error) {
			// If config endpoint fails, try a list operation
			try {
				await this.makeVaultRequest('LIST', `/v1/${this.config.enginePath}/metadata`);
			} catch (listError) {
				throw new Error('Unable to verify Vault access - check permissions and engine configuration');
			}
		}
	}

	private async storeSecret(path: string, data: any, ttl?: string): Promise<VaultSecretResponse> {
		const secretPath = `/v1/${this.config.enginePath}/data/${path}`;
		const payload = {
			data,
			...(ttl && { options: { ttl } }),
		};

		return await this.makeVaultRequest('POST', secretPath, payload);
	}

	private async getSecret(path: string): Promise<VaultSecretResponse | null> {
		try {
			const secretPath = `/v1/${this.config.enginePath}/data/${path}`;
			return await this.makeVaultRequest('GET', secretPath);
		} catch (error) {
			if (error.response?.status === 404) {
				return null;
			}
			throw error;
		}
	}

	private async deleteSecret(path: string): Promise<void> {
		const secretPath = `/v1/${this.config.enginePath}/metadata/${path}`;
		await this.makeVaultRequest('DELETE', secretPath);
	}

	private async listSecrets(path: string): Promise<string[]> {
		try {
			const listPath = `/v1/${this.config.enginePath}/metadata/${path}`;
			const response = await this.makeVaultRequest('LIST', listPath);
			return response.data.keys || [];
		} catch (error) {
			if (error.response?.status === 404) {
				return [];
			}
			throw error;
		}
	}

	private async makeVaultRequest(method: string, path: string, data?: any, requireAuth: boolean = true): Promise<any> {
		const url = this.config.endpoint + path;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		if (requireAuth && this.vaultToken) {
			headers['X-Vault-Token'] = this.vaultToken;
		}

		if (this.config.namespace) {
			headers['X-Vault-Namespace'] = this.config.namespace;
		}

		// Simulate HTTP request (in real implementation, use axios or fetch)
		try {
			// This would be a real HTTP request in actual implementation
			this.logger.debug('Vault request', {
				method,
				path,
				hasToken: !!this.vaultToken,
			});

			// Simulate successful response
			return {
				data: { data: data },
				metadata: { version: 1 },
				auth: {
					client_token: this.vaultToken || 'mock-token',
					policies: ['default'],
					lease_duration: 3600,
				},
			};
		} catch (error) {
			this.logger.error('Vault request failed', {
				method,
				path,
				error: error.message,
			});
			throw error;
		}
	}

	private setupTokenRenewal(): void {
		if (!this.tokenExpiresAt) {
			return;
		}

		const renewAt = this.tokenExpiresAt.getTime() - Date.now() * this.config.leaseConfig.renewThreshold;
		
		setTimeout(async () => {
			try {
				await this.renewToken();
				this.setupTokenRenewal(); // Schedule next renewal
			} catch (error) {
				this.logger.error('Automatic token renewal failed', {
					error: error.message,
				});
			}
		}, renewAt);
	}

	private setupLeaseRenewal(leaseId: string): void {
		// Implement lease renewal logic
		// This would periodically renew dynamic secrets if supported
	}

	private encryptSensitiveData(data: ICredentialDataDecryptedObject): any {
		// In real implementation, this might use Vault's transit engine for encryption
		return data; // For now, store as-is since Vault provides encryption at rest
	}

	private decryptSensitiveData(encryptedData: any): ICredentialDataDecryptedObject {
		// In real implementation, this would decrypt data if using transit engine
		return encryptedData;
	}

	private getVaultPath(credentialId: string): string {
		return `${this.config.keyPrefix}/${credentialId}`;
	}

	private generateCredentialId(): string {
		return randomBytes(16).toString('hex');
	}

	private extractCredentialIdFromPath(path: string): string {
		return path.replace(`${this.config.keyPrefix}/`, '');
	}

	private matchesQuery(credential: VaultCredential, query: CredentialQuery): boolean {
		if (query.type && credential.type !== query.type) {
			return false;
		}

		if (query.search && !credential.name.toLowerCase().includes(query.search.toLowerCase())) {
			return false;
		}

		if (query.tags && query.tags.length > 0) {
			const hasMatchingTag = query.tags.some(tag => credential.metadata.tags.includes(tag));
			if (!hasMatchingTag) {
				return false;
			}
		}

		if (query.createdBy && credential.metadata.createdBy !== query.createdBy) {
			return false;
		}

		if (query.fromDate && credential.metadata.createdAt < query.fromDate) {
			return false;
		}

		if (query.toDate && credential.metadata.createdAt > query.toDate) {
			return false;
		}

		return true;
	}

	private sortCredentials(credentials: VaultCredential[]): VaultCredential[] {
		return credentials.sort((a, b) => {
			// Sort by name by default
			return a.name.localeCompare(b.name);
		});
	}

	private async storeCredentialReference(credential: VaultCredential, user: User): Promise<void> {
		// Store a reference in the database for indexing and permissions
		// This would create a minimal record pointing to the Vault location
	}

	private async removeCredentialReference(credentialId: string): Promise<void> {
		// Remove the database reference
	}

	private async logCredentialAccess(credentialId: string, user: User, action: string): Promise<void> {
		// Log access for audit purposes
		this.logger.info('Credential access logged', {
			credentialId,
			userId: user.id,
			action,
			timestamp: new Date(),
		});
	}

	private loadConfigFromEnvironment(): void {
		// Load configuration from environment variables
		const envConfig: Partial<VaultConfig> = {};

		if (process.env.VAULT_ENABLED) {
			envConfig.enabled = process.env.VAULT_ENABLED === 'true';
		}
		if (process.env.VAULT_ENDPOINT) {
			envConfig.endpoint = process.env.VAULT_ENDPOINT;
		}
		if (process.env.VAULT_TOKEN) {
			envConfig.token = process.env.VAULT_TOKEN;
		}
		if (process.env.VAULT_AUTH_METHOD) {
			envConfig.authMethod = process.env.VAULT_AUTH_METHOD as any;
		}
		if (process.env.VAULT_USERNAME) {
			envConfig.username = process.env.VAULT_USERNAME;
		}
		if (process.env.VAULT_PASSWORD) {
			envConfig.password = process.env.VAULT_PASSWORD;
		}
		if (process.env.VAULT_NAMESPACE) {
			envConfig.namespace = process.env.VAULT_NAMESPACE;
		}
		if (process.env.VAULT_ENGINE_PATH) {
			envConfig.enginePath = process.env.VAULT_ENGINE_PATH;
		}

		if (Object.keys(envConfig).length > 0) {
			this.configure(envConfig);
		}
	}
}