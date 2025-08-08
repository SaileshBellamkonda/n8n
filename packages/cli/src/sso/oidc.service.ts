// Community Edition OIDC Service
// OpenID Connect authentication service for community edition (disabled)

import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';

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
}

export interface OidcUserData {
	email: string;
	firstName?: string;
	lastName?: string;
	sub: string;
	claims: Record<string, any>;
}

export interface OidcTokens {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresIn?: number;
}

@Injectable()
export class CommunityOidcService {
	private config: OidcConfig = {
		enabled: false,
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
	};

	constructor(private readonly logger: Logger) {}

	/**
	 * Check if OIDC is enabled (always false in community edition)
	 */
	isEnabled(): boolean {
		return false;
	}

	/**
	 * Configure OIDC settings (no-op in community edition)
	 */
	configure(config: Partial<OidcConfig>): void {
		this.logger.info('OIDC configuration is not available in community edition');
	}

	/**
	 * Get OIDC authorization URL (not available in community edition)
	 */
	getAuthorizationUrl(state?: string): string {
		throw new BadRequestError('OIDC authentication is not available in community edition');
	}

	/**
	 * Exchange authorization code for tokens (not available in community edition)
	 */
	async exchangeCodeForTokens(code: string, state?: string): Promise<OidcTokens> {
		throw new BadRequestError('OIDC authentication is not available in community edition');
	}

	/**
	 * Get user info from tokens (not available in community edition)
	 */
	async getUserInfo(accessToken: string): Promise<OidcUserData> {
		throw new BadRequestError('OIDC user info is not available in community edition');
	}

	/**
	 * Refresh access token (not available in community edition)
	 */
	async refreshToken(refreshToken: string): Promise<OidcTokens> {
		throw new BadRequestError('OIDC token refresh is not available in community edition');
	}

	/**
	 * Get OIDC logout URL (not available in community edition)
	 */
	getLogoutUrl(idToken?: string): string {
		throw new BadRequestError('OIDC logout is not available in community edition');
	}

	/**
	 * Validate OIDC configuration (always false in community edition)
	 */
	async validateConfiguration(): Promise<boolean> {
		return false;
	}

	/**
	 * Get OIDC configuration
	 */
	getConfig(): OidcConfig {
		return this.config;
	}

	/**
	 * Discover OIDC endpoints (not available in community edition)
	 */
	async discoverEndpoints(): Promise<Record<string, string>> {
		throw new BadRequestError('OIDC endpoint discovery is not available in community edition');
	}

	/**
	 * Test OIDC connection (always fails in community edition)
	 */
	async testConnection(): Promise<boolean> {
		this.logger.info('OIDC connection testing is not available in community edition');
		return false;
	}
}