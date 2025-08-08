// Community Edition SAML Service
// SAML authentication service for community edition (disabled)

import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';

export interface SamlConfig {
	enabled: boolean;
	entityId: string;
	ssoUrl: string;
	certificate: string;
	signatureAlgorithm: string;
	nameIdFormat: string;
	emailAttribute: string;
	firstNameAttribute: string;
	lastNameAttribute: string;
}

export interface SamlUserData {
	email: string;
	firstName?: string;
	lastName?: string;
	attributes: Record<string, any>;
}

@Injectable()
export class CommunitySamlService {
	private config: SamlConfig = {
		enabled: false,
		entityId: '',
		ssoUrl: '',
		certificate: '',
		signatureAlgorithm: 'sha256',
		nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
		emailAttribute: 'email',
		firstNameAttribute: 'firstName',
		lastNameAttribute: 'lastName',
	};

	constructor(private readonly logger: Logger) {}

	/**
	 * Check if SAML is enabled (always false in community edition)
	 */
	isEnabled(): boolean {
		return false;
	}

	/**
	 * Configure SAML settings (no-op in community edition)
	 */
	configure(config: Partial<SamlConfig>): void {
		this.logger.info('SAML configuration is not available in community edition');
	}

	/**
	 * Get SAML login URL (not available in community edition)
	 */
	getLoginUrl(returnUrl?: string): string {
		throw new BadRequestError('SAML authentication is not available in community edition');
	}

	/**
	 * Process SAML response (not available in community edition)
	 */
	async processSamlResponse(samlResponse: string): Promise<SamlUserData> {
		throw new BadRequestError('SAML authentication is not available in community edition');
	}

	/**
	 * Get SAML logout URL (not available in community edition)
	 */
	getLogoutUrl(): string {
		throw new BadRequestError('SAML logout is not available in community edition');
	}

	/**
	 * Generate SAML metadata (not available in community edition)
	 */
	generateMetadata(): string {
		throw new BadRequestError('SAML metadata generation is not available in community edition');
	}

	/**
	 * Validate SAML configuration (always false in community edition)
	 */
	validateConfiguration(): boolean {
		return false;
	}

	/**
	 * Get SAML configuration
	 */
	getConfig(): SamlConfig {
		return this.config;
	}

	/**
	 * Test SAML connection (always fails in community edition)
	 */
	async testConnection(): Promise<boolean> {
		this.logger.info('SAML connection testing is not available in community edition');
		return false;
	}
}