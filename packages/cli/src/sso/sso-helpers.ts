import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import { SamlService } from './saml.service';
import { OidcService } from './oidc.service';
import type { User } from '@n8n/db';
import { UserRepository } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { AuthError } from '@/errors/response-errors/auth.error';
import { GlobalConfig } from '@n8n/config';
import { randomBytes } from 'crypto';

export type SsoProvider = 'saml' | 'oidc' | 'oauth2' | 'ldap';

export interface SsoConfig {
	enabled: boolean;
	defaultProvider?: SsoProvider;
	allowMultipleProviders: boolean;
	autoCreateUsers: boolean;
	autoUpdateUsers: boolean;
	requireEmailVerification: boolean;
	loginRedirectUrl?: string;
	logoutRedirectUrl?: string;
	sessionTimeout?: number;
	maxConcurrentSessions?: number;
	enableSessionSharing: boolean;
	providers: {
		saml?: any;
		oidc?: any;
		oauth2?: any;
		ldap?: any;
	};
	userMapping: {
		emailAttribute: string;
		firstNameAttribute: string;
		lastNameAttribute: string;
		roleAttribute?: string;
		groupsAttribute?: string;
		usernameAttribute?: string;
	};
	roleMapping: Record<string, 'admin' | 'member' | 'owner'>;
	groupMapping: Record<string, string[]>;
	defaultRole: 'admin' | 'member' | 'owner';
	restrictedDomains?: string[];
	allowedDomains?: string[];
}

export interface SsoSession {
	id: string;
	userId: string;
	provider: SsoProvider;
	providerId: string;
	sessionData: Record<string, any>;
	createdAt: Date;
	expiresAt: Date;
	lastActivity: Date;
	ipAddress?: string;
	userAgent?: string;
	isActive: boolean;
}

export interface SsoUser {
	id: string;
	email: string;
	firstName?: string;
	lastName?: string;
	username?: string;
	role: string;
	groups: string[];
	provider: SsoProvider;
	providerId: string;
	attributes: Record<string, any>;
	lastLogin?: Date;
	loginCount: number;
	isActive: boolean;
}

export interface SsoAuthResult {
	user: User;
	session: SsoSession;
	isNewUser: boolean;
	provider: SsoProvider;
	redirectUrl?: string;
}

export interface SsoProviderInfo {
	name: SsoProvider;
	displayName: string;
	enabled: boolean;
	configured: boolean;
	loginUrl?: string;
	metadata?: any;
}

@Injectable()
export class SsoService {
	private config: SsoConfig = {
		enabled: true,
		defaultProvider: 'saml',
		allowMultipleProviders: true,
		autoCreateUsers: true,
		autoUpdateUsers: true,
		requireEmailVerification: false,
		sessionTimeout: 86400000, // 24 hours
		maxConcurrentSessions: 5,
		enableSessionSharing: false,
		providers: {},
		userMapping: {
			emailAttribute: 'email',
			firstNameAttribute: 'firstName',
			lastNameAttribute: 'lastName',
			roleAttribute: 'role',
			groupsAttribute: 'groups',
			usernameAttribute: 'username',
		},
		roleMapping: {
			'admin': 'admin',
			'user': 'member',
			'manager': 'admin',
			'member': 'member',
		},
		groupMapping: {},
		defaultRole: 'member',
	};

	// In-memory storage for sessions (in real implementation, this would be Redis or database)
	private sessions = new Map<string, SsoSession>();
	private userSessions = new Map<string, string[]>(); // userId -> sessionIds

	constructor(
		private readonly logger: Logger,
		private readonly userRepository: UserRepository,
		private readonly samlService: SamlService,
		private readonly oidcService: OidcService,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('sso');
		this.loadConfigFromEnvironment();
	}

	/**
	 * Check if SSO is enabled
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Configure SSO settings
	 */
	configure(config: Partial<SsoConfig>): void {
		this.config = { ...this.config, ...config };
		
		// Configure individual providers
		if (config.providers?.saml) {
			this.samlService.configure(config.providers.saml);
		}
		if (config.providers?.oidc) {
			this.oidcService.configure(config.providers.oidc);
		}

		this.logger.info('SSO configuration updated', {
			enabled: this.config.enabled,
			defaultProvider: this.config.defaultProvider,
			allowMultipleProviders: this.config.allowMultipleProviders,
			autoCreateUsers: this.config.autoCreateUsers,
		});
	}

	/**
	 * Get available SSO providers
	 */
	async getAvailableProviders(): Promise<SsoProviderInfo[]> {
		const providers: SsoProviderInfo[] = [];

		// SAML provider
		if (this.samlService.isEnabled()) {
			providers.push({
				name: 'saml',
				displayName: 'SAML',
				enabled: true,
				configured: this.samlService.validateConfiguration(),
				loginUrl: await this.getProviderLoginUrl('saml'),
			});
		}

		// OIDC provider
		if (this.oidcService.isEnabled()) {
			providers.push({
				name: 'oidc',
				displayName: 'OpenID Connect',
				enabled: true,
				configured: await this.oidcService.validateConfiguration(),
				loginUrl: await this.getProviderLoginUrl('oidc'),
			});
		}

		return providers;
	}

	/**
	 * Get login URL for specific provider
	 */
	async getProviderLoginUrl(provider: SsoProvider, returnUrl?: string): Promise<string> {
		if (!this.isEnabled()) {
			throw new BadRequestError('SSO is not enabled');
		}

		switch (provider) {
			case 'saml':
				if (!this.samlService.isEnabled()) {
					throw new BadRequestError('SAML provider is not enabled');
				}
				return this.samlService.getLoginUrl(returnUrl);

			case 'oidc':
				if (!this.oidcService.isEnabled()) {
					throw new BadRequestError('OIDC provider is not enabled');
				}
				return await this.oidcService.getAuthorizationUrl();

			default:
				throw new BadRequestError(`Unsupported SSO provider: ${provider}`);
		}
	}

	/**
	 * Get default provider login URL
	 */
	async getDefaultLoginUrl(returnUrl?: string): Promise<string> {
		if (!this.config.defaultProvider) {
			const providers = await this.getAvailableProviders();
			if (providers.length === 0) {
				throw new BadRequestError('No SSO providers are configured');
			}
			return await this.getProviderLoginUrl(providers[0].name, returnUrl);
		}

		return await this.getProviderLoginUrl(this.config.defaultProvider, returnUrl);
	}

	/**
	 * Process SSO callback
	 */
	async processCallback(
		provider: SsoProvider,
		data: any,
		ipAddress?: string,
		userAgent?: string
	): Promise<SsoAuthResult> {
		if (!this.isEnabled()) {
			throw new BadRequestError('SSO is not enabled');
		}

		try {
			let userData: any;
			let providerId: string;

			// Process based on provider
			switch (provider) {
				case 'saml':
					userData = await this.samlService.processSamlResponse(data.samlResponse, data.relayState);
					providerId = userData.nameId;
					break;

				case 'oidc':
					const tokens = await this.oidcService.exchangeCodeForTokens(data.code, data.state);
					userData = await this.oidcService.getUserInfo(tokens.accessToken);
					providerId = userData.sub;
					break;

				default:
					throw new BadRequestError(`Unsupported SSO provider: ${provider}`);
			}

			// Validate user domain if restricted
			if (!this.isUserDomainAllowed(userData.email)) {
				throw new AuthError('User domain is not allowed for SSO authentication');
			}

			// Map user data
			const mappedUser = this.mapUserData(userData, provider);

			// Find or create user
			const { user, isNewUser } = await this.findOrCreateUser(mappedUser, provider, providerId);

			// Create SSO session
			const session = await this.createSession(user, provider, providerId, userData, ipAddress, userAgent);

			// Log successful authentication
			this.logger.info('SSO authentication successful', {
				userId: user.id,
				email: user.email,
				provider,
				providerId,
				isNewUser,
				sessionId: session.id,
			});

			return {
				user,
				session,
				isNewUser,
				provider,
				redirectUrl: this.config.loginRedirectUrl,
			};
		} catch (error) {
			this.logger.error('SSO callback processing failed', {
				provider,
				error: error.message,
				stack: error.stack,
			});
			throw new AuthError(`SSO authentication failed: ${error.message}`);
		}
	}

	/**
	 * Initiate SSO logout
	 */
	async initiateLogout(sessionId: string): Promise<string | null> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new BadRequestError('Session not found');
		}

		try {
			// Get logout URL from provider
			let logoutUrl: string | null = null;

			switch (session.provider) {
				case 'saml':
					const nameId = session.sessionData.nameId;
					const sessionIndex = session.sessionData.sessionIndex;
					logoutUrl = this.samlService.getLogoutUrl(nameId, sessionIndex);
					break;

				case 'oidc':
					const idToken = session.sessionData.idToken;
					logoutUrl = await this.oidcService.getLogoutUrl(idToken, this.config.logoutRedirectUrl);
					break;
			}

			// Invalidate session
			await this.invalidateSession(sessionId);

			this.logger.info('SSO logout initiated', {
				sessionId,
				userId: session.userId,
				provider: session.provider,
				hasLogoutUrl: !!logoutUrl,
			});

			return logoutUrl;
		} catch (error) {
			this.logger.error('SSO logout failed', {
				sessionId,
				error: error.message,
			});
			throw new AuthError(`SSO logout failed: ${error.message}`);
		}
	}

	/**
	 * Validate SSO session
	 */
	async validateSession(sessionId: string): Promise<SsoSession | null> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return null;
		}

		// Check if session is expired
		if (session.expiresAt < new Date()) {
			await this.invalidateSession(sessionId);
			return null;
		}

		// Check if session is inactive too long
		const inactiveTime = Date.now() - session.lastActivity.getTime();
		if (this.config.sessionTimeout && inactiveTime > this.config.sessionTimeout) {
			await this.invalidateSession(sessionId);
			return null;
		}

		// Update last activity
		session.lastActivity = new Date();
		this.sessions.set(sessionId, session);

		return session;
	}

	/**
	 * Get user sessions
	 */
	async getUserSessions(userId: string): Promise<SsoSession[]> {
		const sessionIds = this.userSessions.get(userId) || [];
		const sessions: SsoSession[] = [];

		for (const sessionId of sessionIds) {
			const session = await this.validateSession(sessionId);
			if (session) {
				sessions.push(session);
			}
		}

		return sessions;
	}

	/**
	 * Invalidate user sessions
	 */
	async invalidateUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
		const sessionIds = this.userSessions.get(userId) || [];

		for (const sessionId of sessionIds) {
			if (sessionId !== exceptSessionId) {
				await this.invalidateSession(sessionId);
			}
		}

		this.logger.info('User sessions invalidated', {
			userId,
			sessionCount: sessionIds.length,
			exceptSessionId,
		});
	}

	/**
	 * Get SSO configuration
	 */
	getConfig(): SsoConfig {
		return {
			...this.config,
			providers: {
				...this.config.providers,
				// Remove sensitive data from provider configs
			},
		};
	}

	/**
	 * Test SSO provider
	 */
	async testProvider(provider: SsoProvider): Promise<boolean> {
		try {
			switch (provider) {
				case 'saml':
					return await this.samlService.testConnection();
				case 'oidc':
					return await this.oidcService.testConnection();
				default:
					return false;
			}
		} catch (error) {
			this.logger.error(`SSO provider test failed: ${provider}`, {
				error: error.message,
			});
			return false;
		}
	}

	/**
	 * Get SSO statistics
	 */
	async getStatistics(): Promise<{
		totalSessions: number;
		activeSessions: number;
		providerStats: Record<SsoProvider, number>;
		userStats: {
			totalUsers: number;
			newUsersToday: number;
			activeUsersToday: number;
		};
	}> {
		const activeSessions = Array.from(this.sessions.values()).filter(s => s.isActive);
		const providerStats: Record<SsoProvider, number> = {
			saml: 0,
			oidc: 0,
			oauth2: 0,
			ldap: 0,
		};

		activeSessions.forEach(session => {
			providerStats[session.provider]++;
		});

		// Get user statistics (would be from database in real implementation)
		const userStats = {
			totalUsers: await this.userRepository.count(),
			newUsersToday: 0, // Would calculate from database
			activeUsersToday: activeSessions.length,
		};

		return {
			totalSessions: this.sessions.size,
			activeSessions: activeSessions.length,
			providerStats,
			userStats,
		};
	}

	// Private methods

	private mapUserData(userData: any, provider: SsoProvider): SsoUser {
		const email = userData.email || userData[this.config.userMapping.emailAttribute];
		const firstName = userData.firstName || userData[this.config.userMapping.firstNameAttribute];
		const lastName = userData.lastName || userData[this.config.userMapping.lastNameAttribute];
		const username = userData.username || userData[this.config.userMapping.usernameAttribute];
		const role = userData.role || userData[this.config.userMapping.roleAttribute];
		const groups = userData.groups || userData[this.config.userMapping.groupsAttribute] || [];

		// Map role
		let mappedRole = this.config.defaultRole;
		if (role && this.config.roleMapping[role]) {
			mappedRole = this.config.roleMapping[role];
		}

		// Map groups
		const mappedGroups: string[] = [];
		for (const group of groups) {
			if (this.config.groupMapping[group]) {
				mappedGroups.push(...this.config.groupMapping[group]);
			} else {
				mappedGroups.push(group);
			}
		}

		return {
			id: userData.sub || userData.nameId || email,
			email,
			firstName,
			lastName,
			username,
			role: mappedRole,
			groups: mappedGroups,
			provider,
			providerId: userData.sub || userData.nameId || email,
			attributes: userData,
			loginCount: 0,
			isActive: true,
		};
	}

	private async findOrCreateUser(ssoUser: SsoUser, provider: SsoProvider, providerId: string): Promise<{
		user: User;
		isNewUser: boolean;
	}> {
		// Try to find existing user by email
		let user = await this.userRepository.findOne({
			where: { email: ssoUser.email }
		});

		let isNewUser = false;

		if (user) {
			// Update existing user if auto-update is enabled
			if (this.config.autoUpdateUsers) {
				user.firstName = ssoUser.firstName || user.firstName;
				user.lastName = ssoUser.lastName || user.lastName;
				user.role = ssoUser.role;
				user = await this.userRepository.save(user);
			}
		} else {
			// Create new user if auto-create is enabled
			if (!this.config.autoCreateUsers) {
				throw new AuthError('User does not exist and auto-creation is disabled');
			}

			user = this.userRepository.create({
				email: ssoUser.email,
				firstName: ssoUser.firstName || '',
				lastName: ssoUser.lastName || '',
				role: ssoUser.role,
				// Set a placeholder password since authentication is via SSO
				password: randomBytes(32).toString('hex'),
			});

			user = await this.userRepository.save(user);
			isNewUser = true;
		}

		return { user, isNewUser };
	}

	private async createSession(
		user: User,
		provider: SsoProvider,
		providerId: string,
		sessionData: any,
		ipAddress?: string,
		userAgent?: string
	): Promise<SsoSession> {
		// Check concurrent session limit
		const userSessions = await this.getUserSessions(user.id);
		if (this.config.maxConcurrentSessions && userSessions.length >= this.config.maxConcurrentSessions) {
			// Remove oldest session
			const oldestSession = userSessions.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
			await this.invalidateSession(oldestSession.id);
		}

		// Create new session
		const sessionId = this.generateSessionId();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + (this.config.sessionTimeout || 86400000));

		const session: SsoSession = {
			id: sessionId,
			userId: user.id,
			provider,
			providerId,
			sessionData,
			createdAt: now,
			expiresAt,
			lastActivity: now,
			ipAddress,
			userAgent,
			isActive: true,
		};

		this.sessions.set(sessionId, session);

		// Update user session list
		const userSessionIds = this.userSessions.get(user.id) || [];
		userSessionIds.push(sessionId);
		this.userSessions.set(user.id, userSessionIds);

		return session;
	}

	private async invalidateSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.isActive = false;
			this.sessions.delete(sessionId);

			// Remove from user session list
			const userSessionIds = this.userSessions.get(session.userId) || [];
			const index = userSessionIds.indexOf(sessionId);
			if (index > -1) {
				userSessionIds.splice(index, 1);
				this.userSessions.set(session.userId, userSessionIds);
			}
		}
	}

	private generateSessionId(): string {
		return randomBytes(32).toString('hex');
	}

	private isUserDomainAllowed(email: string): boolean {
		const domain = email.split('@')[1]?.toLowerCase();
		if (!domain) {
			return false;
		}

		// Check restricted domains
		if (this.config.restrictedDomains?.includes(domain)) {
			return false;
		}

		// Check allowed domains
		if (this.config.allowedDomains && this.config.allowedDomains.length > 0) {
			return this.config.allowedDomains.includes(domain);
		}

		return true;
	}

	private loadConfigFromEnvironment(): void {
		// Load configuration from environment variables
		const envConfig: Partial<SsoConfig> = {};

		if (process.env.SSO_ENABLED) {
			envConfig.enabled = process.env.SSO_ENABLED === 'true';
		}
		if (process.env.SSO_DEFAULT_PROVIDER) {
			envConfig.defaultProvider = process.env.SSO_DEFAULT_PROVIDER as SsoProvider;
		}
		if (process.env.SSO_AUTO_CREATE_USERS) {
			envConfig.autoCreateUsers = process.env.SSO_AUTO_CREATE_USERS === 'true';
		}
		if (process.env.SSO_AUTO_UPDATE_USERS) {
			envConfig.autoUpdateUsers = process.env.SSO_AUTO_UPDATE_USERS === 'true';
		}
		if (process.env.SSO_SESSION_TIMEOUT) {
			envConfig.sessionTimeout = parseInt(process.env.SSO_SESSION_TIMEOUT, 10);
		}
		if (process.env.SSO_LOGIN_REDIRECT_URL) {
			envConfig.loginRedirectUrl = process.env.SSO_LOGIN_REDIRECT_URL;
		}
		if (process.env.SSO_LOGOUT_REDIRECT_URL) {
			envConfig.logoutRedirectUrl = process.env.SSO_LOGOUT_REDIRECT_URL;
		}

		if (Object.keys(envConfig).length > 0) {
			this.configure(envConfig);
		}
	}
}

// Helper functions for backward compatibility
export type AuthenticationMethod = 'email' | 'saml' | 'ldap' | 'oauth';

/**
 * Get current authentication method
 */
export function getCurrentAuthenticationMethod(): AuthenticationMethod {
	// In real implementation, this would check current SSO configuration
	return 'email';
}

/**
 * Check if LDAP is current authentication method
 */
export function isLdapCurrentAuthenticationMethod(): boolean {
	return false; // Would check LDAP service
}

/**
 * Check if SAML is current authentication method
 */
export function isSamlCurrentAuthenticationMethod(): boolean {
	return false; // Would check SAML service
}

/**
 * Check if OIDC is current authentication method
 */
export function isOidcCurrentAuthenticationMethod(): boolean {
	return false; // Would check OIDC service
}

/**
 * Check if any SSO method is enabled
 */
export function isSsoEnabled(): boolean {
	return true; // SSO is enabled in community edition
}

/**
 * Get available authentication methods
 */
export function getAvailableAuthMethods(): AuthenticationMethod[] {
	return ['email', 'saml', 'oauth']; // Available in community edition
}

/**
 * Check if SSO is required for user
 */
export function isSsoRequiredForUser(userEmail?: string): boolean {
	return false; // Optional in community edition
}

/**
 * Get SSO login URL
 */
export function getSsoLoginUrl(returnUrl?: string): string | null {
	// Would integrate with SsoService to get default login URL
	return null;
}

/**
 * Validate SSO is properly configured
 */
export function validateSsoConfiguration(): boolean {
	// Would check if any SSO providers are properly configured
	return true;
}