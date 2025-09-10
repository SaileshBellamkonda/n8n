import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { UserRepository } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { AuthError } from '@/errors/response-errors/auth.error';
import { GlobalConfig } from '@n8n/config';
import { createHash } from 'crypto';

export interface LdapConfig {
	enabled: boolean;
	server: string;
	port: number;
	bindDn: string;
	bindPassword: string;
	baseDn: string;
	userFilter: string;
	usernameAttribute: string;
	emailAttribute: string;
	firstNameAttribute: string;
	lastNameAttribute: string;
	groupFilter?: string;
	groupAttribute?: string;
	memberAttribute?: string;
	enableStartTLS?: boolean;
	verifyCertificate?: boolean;
	connectionTimeout?: number;
	searchTimeout?: number;
	maxSearchResults?: number;
	adminRoleFilter?: string;
	managerRoleFilter?: string;
}

export interface LdapUser {
	username: string;
	email: string;
	firstName: string;
	lastName: string;
	dn: string;
	groups: string[];
	roles: string[];
	attributes: Record<string, any>;
}

export interface LdapConnection {
	connected: boolean;
	lastConnected?: Date;
	lastError?: string;
	serverInfo?: {
		version: string;
		vendor: string;
		supportedControls: string[];
		supportedExtensions: string[];
	};
}

export interface LdapSearchResult {
	users: LdapUser[];
	totalCount: number;
	hasMore: boolean;
}

export interface LdapGroupMapping {
	ldapGroup: string;
	n8nRole: 'admin' | 'member' | 'owner';
	autoAssign: boolean;
}

@Injectable()
export class LdapService {
	private config: LdapConfig = {
		enabled: true, // Enable LDAP in community edition
		server: 'ldap://localhost',
		port: 389,
		bindDn: '',
		bindPassword: '',
		baseDn: 'dc=example,dc=com',
		userFilter: '(uid={{username}})',
		usernameAttribute: 'uid',
		emailAttribute: 'mail',
		firstNameAttribute: 'givenName',
		lastNameAttribute: 'sn',
		groupFilter: '(member={{userDn}})',
		groupAttribute: 'cn',
		memberAttribute: 'member',
		enableStartTLS: false,
		verifyCertificate: true,
		connectionTimeout: 5000,
		searchTimeout: 10000,
		maxSearchResults: 1000,
		adminRoleFilter: '(memberOf=cn=n8n-admins,ou=groups,dc=example,dc=com)',
		managerRoleFilter: '(memberOf=cn=n8n-managers,ou=groups,dc=example,dc=com)',
	};

	private connection: any = null;
	private connectionStatus: LdapConnection = { connected: false };
	private groupMappings: LdapGroupMapping[] = [];
	private userCache = new Map<string, { user: LdapUser; cachedAt: Date }>();
	private cacheTimeout = 300000; // 5 minutes

	constructor(
		private readonly logger: Logger,
		private readonly userRepository: UserRepository,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('ldap');
		this.loadConfigFromEnvironment();
	}

	/**
	 * Check if LDAP is enabled
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Configure LDAP settings
	 */
	configure(config: Partial<LdapConfig>): void {
		this.config = { ...this.config, ...config };
		this.logger.info('LDAP configuration updated', {
			server: this.config.server,
			port: this.config.port,
			baseDn: this.config.baseDn,
		});

		// Reset connection to apply new config
		if (this.connection) {
			this.disconnect();
		}
	}

	/**
	 * Authenticate user via LDAP
	 */
	async authenticate(username: string, password: string): Promise<User | null> {
		if (!this.isEnabled()) {
			throw new AuthError('LDAP authentication is not enabled');
		}

		if (!username || !password) {
			throw new BadRequestError('Username and password are required');
		}

		this.logger.debug(`Attempting LDAP authentication for user: ${username}`);

		try {
			// Connect to LDAP server
			await this.connect();

			// Search for user
			const ldapUser = await this.searchUser(username);
			if (!ldapUser) {
				this.logger.warn(`User not found in LDAP: ${username}`);
				return null;
			}

			// Authenticate user
			const authenticated = await this.authenticateUser(ldapUser.dn, password);
			if (!authenticated) {
				this.logger.warn(`LDAP authentication failed for user: ${username}`);
				return null;
			}

			// Get user groups and roles
			ldapUser.groups = await this.getUserGroups(ldapUser.dn);
			ldapUser.roles = this.mapGroupsToRoles(ldapUser.groups);

			// Sync user to local database
			const user = await this.syncUser(ldapUser);

			this.logger.info(`LDAP authentication successful for user: ${username}`, {
				userId: user.id,
				email: user.email,
				groups: ldapUser.groups.length,
				roles: ldapUser.roles,
			});

			// Cache user
			this.cacheUser(username, ldapUser);

			return user;
		} catch (error) {
			this.logger.error('LDAP authentication error', {
				username,
				error: error.message,
				stack: error.stack,
			});
			throw new AuthError(`LDAP authentication failed: ${error.message}`);
		} finally {
			await this.disconnect();
		}
	}

	/**
	 * Sync LDAP user to local database
	 */
	async syncUser(ldapUser: LdapUser): Promise<User> {
		let user = await this.userRepository.findOne({
			where: { email: ldapUser.email }
		});

		if (user) {
			// Update existing user
			user.firstName = ldapUser.firstName;
			user.lastName = ldapUser.lastName;
			// Update role based on LDAP groups
			if (ldapUser.roles.includes('admin')) {
				user.role = 'admin';
			} else if (ldapUser.roles.includes('manager')) {
				user.role = 'member'; // Or custom role
			}
		} else {
			// Create new user
			user = this.userRepository.create({
				email: ldapUser.email,
				firstName: ldapUser.firstName,
				lastName: ldapUser.lastName,
				role: ldapUser.roles.includes('admin') ? 'admin' : 'member',
				// Set a placeholder password since authentication is via LDAP
				password: createHash('sha256').update(Math.random().toString()).digest('hex'),
			});
		}

		return await this.userRepository.save(user);
	}

	/**
	 * Test LDAP connection
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.connect();
			const serverInfo = await this.getServerInfo();
			this.connectionStatus.serverInfo = serverInfo;
			
			this.logger.info('LDAP connection test successful', {
				server: this.config.server,
				version: serverInfo.version,
			});
			
			return true;
		} catch (error) {
			this.logger.error('LDAP connection test failed', {
				server: this.config.server,
				error: error.message,
			});
			this.connectionStatus.lastError = error.message;
			return false;
		} finally {
			await this.disconnect();
		}
	}

	/**
	 * Search LDAP users
	 */
	async searchUsers(filter?: string, limit: number = 100, offset: number = 0): Promise<LdapSearchResult> {
		if (!this.isEnabled()) {
			throw new BadRequestError('LDAP search is not available when LDAP is disabled');
		}

		try {
			await this.connect();

			// Build search filter
			let searchFilter = '(objectClass=person)';
			if (filter) {
				searchFilter = `(&${searchFilter}(|(${this.config.usernameAttribute}=*${filter}*)(${this.config.emailAttribute}=*${filter}*)(${this.config.firstNameAttribute}=*${filter}*)(${this.config.lastNameAttribute}=*${filter}*)))`;
			}

			const results = await this.performSearch(searchFilter, limit + 1, offset);
			const hasMore = results.length > limit;
			const users = results.slice(0, limit).map(entry => this.mapLdapEntry(entry));

			return {
				users,
				totalCount: users.length,
				hasMore,
			};
		} catch (error) {
			this.logger.error('LDAP user search failed', {
				filter,
				error: error.message,
			});
			throw new BadRequestError(`LDAP search failed: ${error.message}`);
		} finally {
			await this.disconnect();
		}
	}

	/**
	 * Get LDAP configuration
	 */
	getConfig(): LdapConfig {
		// Return config without sensitive data
		return {
			...this.config,
			bindPassword: this.config.bindPassword ? '***' : '',
		};
	}

	/**
	 * Import users from LDAP
	 */
	async importUsers(userDns: string[]): Promise<User[]> {
		if (!this.isEnabled()) {
			throw new BadRequestError('LDAP import is not available when LDAP is disabled');
		}

		const importedUsers: User[] = [];

		try {
			await this.connect();

			for (const dn of userDns) {
				try {
					const ldapUser = await this.getUserByDn(dn);
					if (ldapUser) {
						ldapUser.groups = await this.getUserGroups(dn);
						ldapUser.roles = this.mapGroupsToRoles(ldapUser.groups);
						const user = await this.syncUser(ldapUser);
						importedUsers.push(user);
					}
				} catch (error) {
					this.logger.warn(`Failed to import user ${dn}`, {
						dn,
						error: error.message,
					});
				}
			}

			this.logger.info(`LDAP import completed`, {
				requested: userDns.length,
				imported: importedUsers.length,
			});

			return importedUsers;
		} catch (error) {
			this.logger.error('LDAP import failed', {
				error: error.message,
			});
			throw new BadRequestError(`LDAP import failed: ${error.message}`);
		} finally {
			await this.disconnect();
		}
	}

	/**
	 * Get connection status
	 */
	getConnectionStatus(): LdapConnection {
		return this.connectionStatus;
	}

	/**
	 * Sync all LDAP users
	 */
	async syncAllUsers(): Promise<{ synced: number; errors: string[] }> {
		const result = { synced: 0, errors: [] };

		try {
			const searchResult = await this.searchUsers(undefined, this.config.maxSearchResults);
			
			for (const ldapUser of searchResult.users) {
				try {
					await this.syncUser(ldapUser);
					result.synced++;
				} catch (error) {
					result.errors.push(`Failed to sync user ${ldapUser.email}: ${error.message}`);
				}
			}

			this.logger.info(`LDAP sync completed`, result);
			return result;
		} catch (error) {
			this.logger.error('LDAP sync failed', { error: error.message });
			throw new BadRequestError(`LDAP sync failed: ${error.message}`);
		}
	}

	/**
	 * Configure group mappings
	 */
	setGroupMappings(mappings: LdapGroupMapping[]): void {
		this.groupMappings = mappings;
		this.logger.info(`LDAP group mappings configured`, {
			count: mappings.length,
		});
	}

	/**
	 * Get group mappings
	 */
	getGroupMappings(): LdapGroupMapping[] {
		return this.groupMappings;
	}

	// Private methods for LDAP operations

	private async connect(): Promise<void> {
		// In a real implementation, this would use ldapjs or similar library
		// For this community edition, we'll simulate the connection
		
		this.logger.debug('Connecting to LDAP server', {
			server: this.config.server,
			port: this.config.port,
		});

		// Simulate connection logic
		if (!this.config.server || !this.config.baseDn) {
			throw new Error('LDAP server and base DN must be configured');
		}

		this.connection = {
			connected: true,
			server: this.config.server,
			port: this.config.port,
		};

		this.connectionStatus = {
			connected: true,
			lastConnected: new Date(),
		};
	}

	private async disconnect(): Promise<void> {
		if (this.connection) {
			this.connection = null;
			this.connectionStatus.connected = false;
			this.logger.debug('Disconnected from LDAP server');
		}
	}

	private async searchUser(username: string): Promise<LdapUser | null> {
		// Simulate user search
		const filter = this.config.userFilter.replace('{{username}}', username);
		
		// In real implementation, perform LDAP search
		// For simulation, return a mock user if username meets criteria
		if (username && username.length > 0) {
			return {
				username,
				email: `${username}@example.com`,
				firstName: username.charAt(0).toUpperCase() + username.slice(1),
				lastName: 'User',
				dn: `uid=${username},${this.config.baseDn}`,
				groups: [],
				roles: [],
				attributes: {},
			};
		}

		return null;
	}

	private async authenticateUser(dn: string, password: string): Promise<boolean> {
		// Simulate authentication
		// In real implementation, attempt to bind with user credentials
		return password.length >= 4; // Simple validation for demo
	}

	private async getUserGroups(userDn: string): Promise<string[]> {
		// Simulate group search
		// In real implementation, search for groups where user is a member
		return ['users', 'employees']; // Mock groups
	}

	private mapGroupsToRoles(groups: string[]): string[] {
		const roles: string[] = [];
		
		for (const mapping of this.groupMappings) {
			if (groups.includes(mapping.ldapGroup)) {
				roles.push(mapping.n8nRole);
			}
		}

		// Default role assignment based on common group names
		if (groups.some(g => g.toLowerCase().includes('admin'))) {
			roles.push('admin');
		} else if (groups.some(g => g.toLowerCase().includes('manager'))) {
			roles.push('manager');
		} else {
			roles.push('member');
		}

		return [...new Set(roles)]; // Remove duplicates
	}

	private async getUserByDn(dn: string): Promise<LdapUser | null> {
		// Simulate get user by DN
		// In real implementation, fetch user details by DN
		const username = dn.split(',')[0].split('=')[1];
		return this.searchUser(username);
	}

	private async performSearch(filter: string, limit: number, offset: number): Promise<any[]> {
		// Simulate LDAP search
		// In real implementation, perform actual LDAP search
		return []; // Mock empty results
	}

	private mapLdapEntry(entry: any): LdapUser {
		// Map LDAP entry to LdapUser
		return {
			username: entry[this.config.usernameAttribute] || '',
			email: entry[this.config.emailAttribute] || '',
			firstName: entry[this.config.firstNameAttribute] || '',
			lastName: entry[this.config.lastNameAttribute] || '',
			dn: entry.dn || '',
			groups: [],
			roles: [],
			attributes: entry,
		};
	}

	private async getServerInfo(): Promise<any> {
		// Simulate getting server info
		return {
			version: '3.0',
			vendor: 'OpenLDAP',
			supportedControls: [],
			supportedExtensions: [],
		};
	}

	private cacheUser(username: string, user: LdapUser): void {
		this.userCache.set(username, {
			user,
			cachedAt: new Date(),
		});

		// Clean old cache entries
		this.cleanCache();
	}

	private cleanCache(): void {
		const now = Date.now();
		for (const [key, value] of this.userCache.entries()) {
			if (now - value.cachedAt.getTime() > this.cacheTimeout) {
				this.userCache.delete(key);
			}
		}
	}

	private loadConfigFromEnvironment(): void {
		// Load configuration from environment variables
		const envConfig: Partial<LdapConfig> = {};

		if (process.env.LDAP_ENABLED) {
			envConfig.enabled = process.env.LDAP_ENABLED === 'true';
		}
		if (process.env.LDAP_SERVER) {
			envConfig.server = process.env.LDAP_SERVER;
		}
		if (process.env.LDAP_PORT) {
			envConfig.port = parseInt(process.env.LDAP_PORT, 10);
		}
		if (process.env.LDAP_BIND_DN) {
			envConfig.bindDn = process.env.LDAP_BIND_DN;
		}
		if (process.env.LDAP_BIND_PASSWORD) {
			envConfig.bindPassword = process.env.LDAP_BIND_PASSWORD;
		}
		if (process.env.LDAP_BASE_DN) {
			envConfig.baseDn = process.env.LDAP_BASE_DN;
		}

		if (Object.keys(envConfig).length > 0) {
			this.configure(envConfig);
		}
	}
}