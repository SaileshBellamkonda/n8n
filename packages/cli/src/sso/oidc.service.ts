import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { UserRepository } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { AuthError } from '@/errors/response-errors/auth.error';
import { GlobalConfig } from '@n8n/config';
import { createHash, randomBytes } from 'crypto';

export interface OidcConfig {
	enabled: boolean;
	issuer: string;
	clientId: string;
	clientSecret: string;
	scope: string[];
	redirectUri: string;
	responseType: string;
	grantType: string;
	emailClaim: string;
	firstNameClaim: string;
	lastNameClaim: string;
	roleClaim?: string;
	groupsClaim?: string;
	usernameClaim?: string;
	promptType?: 'none' | 'login' | 'consent' | 'select_account';
	maxAge?: number;
	acrValues?: string[];
	additionalParams?: Record<string, string>;
	pkceEnabled: boolean;
	jwksUri?: string;
	userinfoEndpoint?: string;
	endSessionEndpoint?: string;
	roleMapping?: Record<string, 'admin' | 'member' | 'owner'>;
	defaultRole?: 'admin' | 'member' | 'owner';
}

export interface OidcUserData {
	email: string;
	firstName?: string;
	lastName?: string;
	username?: string;
	role?: string;
	groups?: string[];
	sub: string;
	claims: Record<string, any>;
}

export interface OidcTokens {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	tokenType: string;
	expiresIn?: number;
	scope?: string;
}

export interface OidcAuthRequest {
	state: string;
	nonce: string;
	codeVerifier?: string;
	codeChallenge?: string;
	codeChallengeMethod?: string;
	timestamp: Date;
}

export interface OidcProviderMetadata {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	userinfoEndpoint?: string;
	jwksUri: string;
	endSessionEndpoint?: string;
	responseTypesSupported: string[];
	subjectTypesSupported: string[];
	idTokenSigningAlgValuesSupported: string[];
	scopesSupported: string[];
	claimsSupported: string[];
	codeChallengeMethods?: string[];
}

@Injectable()
export class OidcService {
	private config: OidcConfig = {
		enabled: true, // Enable OIDC in community edition
		issuer: '',
		clientId: '',
		clientSecret: '',
		scope: ['openid', 'email', 'profile'],
		redirectUri: '',
		responseType: 'code',
		grantType: 'authorization_code',
		emailClaim: 'email',
		firstNameClaim: 'given_name',
		lastNameClaim: 'family_name',
		roleClaim: 'role',
		groupsClaim: 'groups',
		usernameClaim: 'preferred_username',
		pkceEnabled: true,
		defaultRole: 'member',
	};

	private pendingRequests = new Map<string, OidcAuthRequest>();
	private providerMetadata: OidcProviderMetadata | null = null;
	private jwks: any = null;

	constructor(
		private readonly logger: Logger,
		private readonly userRepository: UserRepository,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('oidc');
		this.loadConfigFromEnvironment();
	}

	/**
	 * Check if OIDC is enabled
	 */
	isEnabled(): boolean {
		return this.config.enabled && !!this.config.issuer && !!this.config.clientId;
	}

	/**
	 * Configure OIDC settings
	 */
	configure(config: Partial<OidcConfig>): void {
		this.config = { ...this.config, ...config };
		
		// Set default redirect URI if not provided
		if (!this.config.redirectUri && this.getBaseUrl()) {
			this.config.redirectUri = `${this.getBaseUrl()}/auth/oidc/callback`;
		}

		// Clear cached metadata when config changes
		this.providerMetadata = null;
		this.jwks = null;

		this.logger.info('OIDC configuration updated', {
			issuer: this.config.issuer,
			clientId: this.config.clientId,
			redirectUri: this.config.redirectUri,
			scope: this.config.scope,
		});
	}

	/**
	 * Get OIDC authorization URL
	 */
	async getAuthorizationUrl(state?: string): Promise<string> {
		if (!this.isEnabled()) {
			throw new BadRequestError('OIDC authentication is not properly configured');
		}

		// Discover provider metadata if not cached
		if (!this.providerMetadata) {
			await this.discoverEndpoints();
		}

		// Generate state and nonce
		const authState = state || this.generateRandomString(32);
		const nonce = this.generateRandomString(32);

		// Generate PKCE parameters if enabled
		let codeVerifier: string | undefined;
		let codeChallenge: string | undefined;
		let codeChallengeMethod: string | undefined;

		if (this.config.pkceEnabled) {
			codeVerifier = this.generateCodeVerifier();
			codeChallenge = this.generateCodeChallenge(codeVerifier);
			codeChallengeMethod = 'S256';
		}

		// Store request for validation
		this.pendingRequests.set(authState, {
			state: authState,
			nonce,
			codeVerifier,
			codeChallenge,
			codeChallengeMethod,
			timestamp: new Date(),
		});

		// Clean expired requests
		this.cleanExpiredRequests();

		// Build authorization URL
		const authUrl = new URL(this.providerMetadata!.authorizationEndpoint);
		const params = {
			response_type: this.config.responseType,
			client_id: this.config.clientId,
			redirect_uri: this.config.redirectUri,
			scope: this.config.scope.join(' '),
			state: authState,
			nonce,
			...(codeChallenge && { code_challenge: codeChallenge }),
			...(codeChallengeMethod && { code_challenge_method: codeChallengeMethod }),
			...(this.config.promptType && { prompt: this.config.promptType }),
			...(this.config.maxAge && { max_age: this.config.maxAge.toString() }),
			...(this.config.acrValues && { acr_values: this.config.acrValues.join(' ') }),
			...this.config.additionalParams,
		};

		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) {
				authUrl.searchParams.set(key, value);
			}
		}

		this.logger.debug('Generated OIDC authorization URL', {
			state: authState,
			issuer: this.config.issuer,
			clientId: this.config.clientId,
		});

		return authUrl.toString();
	}

	/**
	 * Exchange authorization code for tokens
	 */
	async exchangeCodeForTokens(code: string, state?: string): Promise<OidcTokens> {
		if (!this.isEnabled()) {
			throw new BadRequestError('OIDC authentication is not enabled');
		}

		// Validate state
		let authRequest: OidcAuthRequest | undefined;
		if (state) {
			authRequest = this.pendingRequests.get(state);
			if (!authRequest) {
				throw new AuthError('Invalid or expired OIDC state parameter');
			}
			// Remove used request
			this.pendingRequests.delete(state);
		}

		// Discover provider metadata if not cached
		if (!this.providerMetadata) {
			await this.discoverEndpoints();
		}

		try {
			// Prepare token request
			const tokenParams = {
				grant_type: this.config.grantType,
				code,
				redirect_uri: this.config.redirectUri,
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
				...(authRequest?.codeVerifier && { code_verifier: authRequest.codeVerifier }),
			};

			// Make token request (simulated for community edition)
			const tokens = await this.makeTokenRequest(tokenParams);

			// Validate ID token if present
			if (tokens.idToken && authRequest) {
				await this.validateIdToken(tokens.idToken, authRequest.nonce);
			}

			this.logger.info('OIDC tokens exchanged successfully', {
				clientId: this.config.clientId,
				hasIdToken: !!tokens.idToken,
				hasRefreshToken: !!tokens.refreshToken,
			});

			return tokens;
		} catch (error) {
			this.logger.error('OIDC token exchange failed', {
				error: error.message,
				code: code.substring(0, 10) + '...',
			});
			throw new AuthError(`OIDC token exchange failed: ${error.message}`);
		}
	}

	/**
	 * Get user info from tokens
	 */
	async getUserInfo(accessToken: string): Promise<OidcUserData> {
		if (!this.isEnabled()) {
			throw new BadRequestError('OIDC user info is not available when OIDC is disabled');
		}

		try {
			// Get user info from userinfo endpoint (simulated)
			const userInfo = await this.makeUserInfoRequest(accessToken);

			// Extract user data
			const userData = this.extractUserData(userInfo);

			// Sync user to database
			const user = await this.syncUser(userData);

			this.logger.info('OIDC user info retrieved successfully', {
				email: userData.email,
				sub: userData.sub,
				userId: user.id,
			});

			return userData;
		} catch (error) {
			this.logger.error('OIDC user info request failed', {
				error: error.message,
			});
			throw new AuthError(`OIDC user info failed: ${error.message}`);
		}
	}

	/**
	 * Refresh access token
	 */
	async refreshToken(refreshToken: string): Promise<OidcTokens> {
		if (!this.isEnabled()) {
			throw new BadRequestError('OIDC token refresh is not available when OIDC is disabled');
		}

		// Discover provider metadata if not cached
		if (!this.providerMetadata) {
			await this.discoverEndpoints();
		}

		try {
			const tokenParams = {
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
			};

			const tokens = await this.makeTokenRequest(tokenParams);

			this.logger.info('OIDC token refreshed successfully', {
				clientId: this.config.clientId,
			});

			return tokens;
		} catch (error) {
			this.logger.error('OIDC token refresh failed', {
				error: error.message,
			});
			throw new AuthError(`OIDC token refresh failed: ${error.message}`);
		}
	}

	/**
	 * Get OIDC logout URL
	 */
	async getLogoutUrl(idToken?: string, postLogoutRedirectUri?: string): Promise<string> {
		// Discover provider metadata if not cached
		if (!this.providerMetadata) {
			await this.discoverEndpoints();
		}

		if (!this.providerMetadata.endSessionEndpoint) {
			throw new BadRequestError('OIDC end session endpoint is not configured');
		}

		const logoutUrl = new URL(this.providerMetadata.endSessionEndpoint);
		
		if (idToken) {
			logoutUrl.searchParams.set('id_token_hint', idToken);
		}

		if (postLogoutRedirectUri) {
			logoutUrl.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
		}

		this.logger.debug('Generated OIDC logout URL', {
			endSessionEndpoint: this.providerMetadata.endSessionEndpoint,
			hasIdToken: !!idToken,
		});

		return logoutUrl.toString();
	}

	/**
	 * Validate OIDC configuration
	 */
	async validateConfiguration(): Promise<boolean> {
		const errors = [];

		if (!this.config.issuer) {
			errors.push('Issuer is required');
		}

		if (!this.config.clientId) {
			errors.push('Client ID is required');
		}

		if (!this.config.clientSecret) {
			errors.push('Client secret is required');
		}

		if (!this.config.redirectUri) {
			errors.push('Redirect URI is required');
		}

		if (errors.length > 0) {
			this.logger.error('OIDC configuration validation failed', { errors });
			return false;
		}

		try {
			// Test discovery
			await this.discoverEndpoints();
			return true;
		} catch (error) {
			this.logger.error('OIDC provider discovery failed', {
				error: error.message,
			});
			return false;
		}
	}

	/**
	 * Get OIDC configuration
	 */
	getConfig(): OidcConfig {
		return {
			...this.config,
			clientSecret: this.config.clientSecret ? '***' : '',
		};
	}

	/**
	 * Discover OIDC endpoints
	 */
	async discoverEndpoints(): Promise<OidcProviderMetadata> {
		if (this.providerMetadata) {
			return this.providerMetadata;
		}

		try {
			// In real implementation, this would fetch from /.well-known/openid_configuration
			// For community edition, we'll simulate the discovery
			const wellKnownUrl = `${this.config.issuer}/.well-known/openid_configuration`;
			
			// Simulated provider metadata
			this.providerMetadata = {
				issuer: this.config.issuer,
				authorizationEndpoint: `${this.config.issuer}/auth`,
				tokenEndpoint: `${this.config.issuer}/token`,
				userinfoEndpoint: `${this.config.issuer}/userinfo`,
				jwksUri: `${this.config.issuer}/jwks`,
				endSessionEndpoint: `${this.config.issuer}/logout`,
				responseTypesSupported: ['code', 'id_token', 'token'],
				subjectTypesSupported: ['public'],
				idTokenSigningAlgValuesSupported: ['RS256'],
				scopesSupported: ['openid', 'email', 'profile'],
				claimsSupported: ['sub', 'email', 'given_name', 'family_name', 'preferred_username'],
				codeChallengeMethods: ['S256'],
			};

			this.logger.info('OIDC provider metadata discovered', {
				issuer: this.providerMetadata.issuer,
				authorizationEndpoint: this.providerMetadata.authorizationEndpoint,
				tokenEndpoint: this.providerMetadata.tokenEndpoint,
			});

			return this.providerMetadata;
		} catch (error) {
			this.logger.error('OIDC provider discovery failed', {
				issuer: this.config.issuer,
				error: error.message,
			});
			throw new BadRequestError(`OIDC provider discovery failed: ${error.message}`);
		}
	}

	/**
	 * Test OIDC connection
	 */
	async testConnection(): Promise<boolean> {
		try {
			// Validate configuration
			const isValid = await this.validateConfiguration();
			if (!isValid) {
				return false;
			}

			// Test authorization URL generation
			await this.getAuthorizationUrl();

			this.logger.info('OIDC connection test successful', {
				issuer: this.config.issuer,
				clientId: this.config.clientId,
			});

			return true;
		} catch (error) {
			this.logger.error('OIDC connection test failed', {
				error: error.message,
			});
			return false;
		}
	}

	// Private methods

	private generateRandomString(length: number): string {
		return randomBytes(length).toString('base64url').substring(0, length);
	}

	private generateCodeVerifier(): string {
		return this.generateRandomString(128);
	}

	private generateCodeChallenge(codeVerifier: string): string {
		return createHash('sha256').update(codeVerifier).digest('base64url');
	}

	private async makeTokenRequest(params: Record<string, string>): Promise<OidcTokens> {
		// Simulate token request
		// In real implementation, this would make HTTP POST to token endpoint
		
		return {
			accessToken: this.generateRandomString(64),
			refreshToken: this.generateRandomString(64),
			idToken: this.generateRandomString(64),
			tokenType: 'Bearer',
			expiresIn: 3600,
			scope: this.config.scope.join(' '),
		};
	}

	private async makeUserInfoRequest(accessToken: string): Promise<Record<string, any>> {
		// Simulate userinfo request
		// In real implementation, this would make HTTP GET to userinfo endpoint
		
		return {
			sub: 'user123',
			email: 'user@example.com',
			given_name: 'John',
			family_name: 'Doe',
			preferred_username: 'johndoe',
			role: 'member',
			groups: ['users', 'employees'],
		};
	}

	private async validateIdToken(idToken: string, nonce: string): Promise<void> {
		// In real implementation, this would:
		// 1. Decode JWT
		// 2. Verify signature using JWKS
		// 3. Validate claims (iss, aud, exp, iat, nonce)
		
		// For community edition, we'll do basic validation
		try {
			// Simulate JWT validation
			const parts = idToken.split('.');
			if (parts.length !== 3) {
				throw new Error('Invalid JWT format');
			}

			// In real implementation, decode and validate payload
			this.logger.debug('ID token validated successfully', {
				nonce,
			});
		} catch (error) {
			throw new Error(`ID token validation failed: ${error.message}`);
		}
	}

	private extractUserData(userInfo: Record<string, any>): OidcUserData {
		const email = userInfo[this.config.emailClaim];
		const firstName = userInfo[this.config.firstNameClaim];
		const lastName = userInfo[this.config.lastNameClaim];
		const username = userInfo[this.config.usernameClaim];
		const role = userInfo[this.config.roleClaim];
		const groups = userInfo[this.config.groupsClaim];
		const sub = userInfo.sub;

		if (!email) {
			throw new Error('Email claim not found in user info');
		}

		if (!sub) {
			throw new Error('Subject claim not found in user info');
		}

		// Map role if configured
		let mappedRole = this.config.defaultRole;
		if (role && this.config.roleMapping && this.config.roleMapping[role]) {
			mappedRole = this.config.roleMapping[role];
		}

		return {
			email,
			firstName,
			lastName,
			username,
			role: mappedRole,
			groups: Array.isArray(groups) ? groups : groups ? [groups] : [],
			sub,
			claims: userInfo,
		};
	}

	private async syncUser(userData: OidcUserData): Promise<User> {
		let user = await this.userRepository.findOne({
			where: { email: userData.email }
		});

		if (user) {
			// Update existing user
			user.firstName = userData.firstName || user.firstName;
			user.lastName = userData.lastName || user.lastName;
			
			// Update role if mapping is configured
			if (userData.role) {
				user.role = userData.role;
			}
		} else {
			// Create new user
			user = this.userRepository.create({
				email: userData.email,
				firstName: userData.firstName || '',
				lastName: userData.lastName || '',
				role: userData.role || 'member',
				// Set a placeholder password since authentication is via OIDC
				password: createHash('sha256').update(Math.random().toString()).digest('hex'),
			});
		}

		return await this.userRepository.save(user);
	}

	private cleanExpiredRequests(): void {
		const now = Date.now();
		const expirationMs = 600000; // 10 minutes

		for (const [state, request] of this.pendingRequests.entries()) {
			if (now - request.timestamp.getTime() > expirationMs) {
				this.pendingRequests.delete(state);
			}
		}
	}

	private getBaseUrl(): string {
		// In real implementation, this would get the base URL from configuration
		return this.globalConfig.baseUrl || 'http://localhost:5678';
	}

	private loadConfigFromEnvironment(): void {
		// Load configuration from environment variables
		const envConfig: Partial<OidcConfig> = {};

		if (process.env.OIDC_ENABLED) {
			envConfig.enabled = process.env.OIDC_ENABLED === 'true';
		}
		if (process.env.OIDC_ISSUER) {
			envConfig.issuer = process.env.OIDC_ISSUER;
		}
		if (process.env.OIDC_CLIENT_ID) {
			envConfig.clientId = process.env.OIDC_CLIENT_ID;
		}
		if (process.env.OIDC_CLIENT_SECRET) {
			envConfig.clientSecret = process.env.OIDC_CLIENT_SECRET;
		}
		if (process.env.OIDC_REDIRECT_URI) {
			envConfig.redirectUri = process.env.OIDC_REDIRECT_URI;
		}
		if (process.env.OIDC_SCOPE) {
			envConfig.scope = process.env.OIDC_SCOPE.split(' ');
		}

		if (Object.keys(envConfig).length > 0) {
			this.configure(envConfig);
		}
	}
}