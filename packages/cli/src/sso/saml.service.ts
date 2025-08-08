import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { UserRepository } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { AuthError } from '@/errors/response-errors/auth.error';
import { GlobalConfig } from '@n8n/config';
import { createHash, randomBytes } from 'crypto';
import { parseStringPromise } from 'xml2js';

export interface SamlConfig {
	enabled: boolean;
	entityId: string;
	ssoUrl: string;
	sloUrl?: string;
	certificate: string;
	privateKey?: string;
	signatureAlgorithm: 'sha1' | 'sha256' | 'sha512';
	digestAlgorithm: 'sha1' | 'sha256' | 'sha512';
	nameIdFormat: string;
	emailAttribute: string;
	firstNameAttribute: string;
	lastNameAttribute: string;
	roleAttribute?: string;
	groupAttribute?: string;
	wantAssertionsSigned: boolean;
	wantResponseSigned: boolean;
	authnRequestsSigned: boolean;
	validateInResponseTo: boolean;
	requestIdExpirationPeriodMs: number;
	disableRequestedAuthnContext: boolean;
	additionalParams?: Record<string, string>;
	attributeMapping?: Record<string, string>;
	roleMapping?: Record<string, 'admin' | 'member' | 'owner'>;
	defaultRole?: 'admin' | 'member' | 'owner';
}

export interface SamlUserData {
	email: string;
	firstName?: string;
	lastName?: string;
	role?: string;
	groups?: string[];
	attributes: Record<string, any>;
	nameId: string;
	sessionIndex?: string;
}

export interface SamlAuthRequest {
	id: string;
	samlRequest: string;
	relayState?: string;
	sigAlg?: string;
	signature?: string;
}

export interface SamlResponse {
	responseXml: string;
	user: SamlUserData;
	inResponseTo?: string;
	sessionNotOnOrAfter?: Date;
}

export interface SamlMetadata {
	xml: string;
	entityId: string;
	ssoUrl: string;
	sloUrl?: string;
	certificate: string;
}

@Injectable()
export class SamlService {
	private config: SamlConfig = {
		enabled: true, // Enable SAML in community edition
		entityId: 'n8n-community',
		ssoUrl: '',
		certificate: '',
		signatureAlgorithm: 'sha256',
		digestAlgorithm: 'sha256',
		nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
		emailAttribute: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
		firstNameAttribute: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
		lastNameAttribute: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
		roleAttribute: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
		groupAttribute: 'http://schemas.xmlsoap.org/claims/Group',
		wantAssertionsSigned: true,
		wantResponseSigned: true,
		authnRequestsSigned: false,
		validateInResponseTo: true,
		requestIdExpirationPeriodMs: 600000, // 10 minutes
		disableRequestedAuthnContext: false,
		defaultRole: 'member',
	};

	private pendingRequests = new Map<string, { timestamp: Date; relayState?: string }>();

	constructor(
		private readonly logger: Logger,
		private readonly userRepository: UserRepository,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('saml');
		this.loadConfigFromEnvironment();
	}

	/**
	 * Check if SAML is enabled
	 */
	isEnabled(): boolean {
		return this.config.enabled && !!this.config.ssoUrl && !!this.config.certificate;
	}

	/**
	 * Configure SAML settings
	 */
	configure(config: Partial<SamlConfig>): void {
		this.config = { ...this.config, ...config };
		this.logger.info('SAML configuration updated', {
			entityId: this.config.entityId,
			ssoUrl: this.config.ssoUrl,
			nameIdFormat: this.config.nameIdFormat,
		});
	}

	/**
	 * Get SAML login URL with authentication request
	 */
	getLoginUrl(returnUrl?: string): string {
		if (!this.isEnabled()) {
			throw new BadRequestError('SAML authentication is not properly configured');
		}

		// Generate unique request ID
		const requestId = this.generateRequestId();
		
		// Store request for validation
		this.pendingRequests.set(requestId, {
			timestamp: new Date(),
			relayState: returnUrl,
		});

		// Clean expired requests
		this.cleanExpiredRequests();

		// Generate SAML AuthnRequest
		const samlRequest = this.generateAuthnRequest(requestId);

		// Base64 encode the request
		const encodedRequest = Buffer.from(samlRequest).toString('base64');

		// Build SSO URL with parameters
		const ssoUrl = new URL(this.config.ssoUrl);
		ssoUrl.searchParams.set('SAMLRequest', encodedRequest);
		
		if (returnUrl) {
			ssoUrl.searchParams.set('RelayState', returnUrl);
		}

		// Add signature if required
		if (this.config.authnRequestsSigned && this.config.privateKey) {
			const signature = this.signRequest(encodedRequest, returnUrl);
			ssoUrl.searchParams.set('SigAlg', `http://www.w3.org/2001/04/xmldsig-more#rsa-${this.config.signatureAlgorithm}`);
			ssoUrl.searchParams.set('Signature', signature);
		}

		this.logger.debug('Generated SAML login URL', {
			requestId,
			ssoUrl: ssoUrl.toString(),
		});

		return ssoUrl.toString();
	}

	/**
	 * Process SAML response
	 */
	async processSamlResponse(samlResponse: string, relayState?: string): Promise<SamlUserData> {
		if (!this.isEnabled()) {
			throw new BadRequestError('SAML authentication is not enabled');
		}

		try {
			// Decode base64 response
			const decodedResponse = Buffer.from(samlResponse, 'base64').toString('utf8');
			
			// Parse XML
			const parsedResponse = await parseStringPromise(decodedResponse, {
				explicitRoot: false,
				ignoreAttrs: false,
				tagNameProcessors: [(name) => name.toLowerCase()],
			});

			// Validate response
			await this.validateSamlResponse(parsedResponse);

			// Extract user data
			const userData = this.extractUserData(parsedResponse);

			// Sync user to database
			const user = await this.syncUser(userData);

			this.logger.info('SAML response processed successfully', {
				email: userData.email,
				nameId: userData.nameId,
				userId: user.id,
			});

			return userData;
		} catch (error) {
			this.logger.error('SAML response processing failed', {
				error: error.message,
				stack: error.stack,
			});
			throw new AuthError(`SAML authentication failed: ${error.message}`);
		}
	}

	/**
	 * Get SAML logout URL
	 */
	getLogoutUrl(nameId?: string, sessionIndex?: string): string {
		if (!this.config.sloUrl) {
			throw new BadRequestError('SAML Single Logout is not configured');
		}

		// Generate logout request
		const requestId = this.generateRequestId();
		const logoutRequest = this.generateLogoutRequest(requestId, nameId, sessionIndex);

		// Base64 encode the request
		const encodedRequest = Buffer.from(logoutRequest).toString('base64');

		// Build SLO URL
		const sloUrl = new URL(this.config.sloUrl);
		sloUrl.searchParams.set('SAMLRequest', encodedRequest);

		this.logger.debug('Generated SAML logout URL', {
			requestId,
			nameId,
			sessionIndex,
		});

		return sloUrl.toString();
	}

	/**
	 * Generate SAML metadata
	 */
	generateMetadata(): string {
		const entityId = this.config.entityId;
		const acsUrl = `${this.getBaseUrl()}/auth/saml/callback`;
		const sloUrl = `${this.getBaseUrl()}/auth/saml/logout`;

		const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor AuthnRequestsSigned="${this.config.authnRequestsSigned}" WantAssertionsSigned="${this.config.wantAssertionsSigned}" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>${this.config.nameIdFormat}</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="1"/>
    ${this.config.sloUrl ? `<SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sloUrl}"/>` : ''}
    ${this.config.privateKey ? this.generateKeyDescriptor() : ''}
  </SPSSODescriptor>
</EntityDescriptor>`;

		return metadata;
	}

	/**
	 * Validate SAML configuration
	 */
	validateConfiguration(): boolean {
		const errors = [];

		if (!this.config.entityId) {
			errors.push('Entity ID is required');
		}

		if (!this.config.ssoUrl) {
			errors.push('SSO URL is required');
		}

		if (!this.config.certificate) {
			errors.push('Certificate is required');
		}

		if (this.config.authnRequestsSigned && !this.config.privateKey) {
			errors.push('Private key is required for signed requests');
		}

		if (errors.length > 0) {
			this.logger.error('SAML configuration validation failed', { errors });
			return false;
		}

		return true;
	}

	/**
	 * Get SAML configuration
	 */
	getConfig(): SamlConfig {
		return {
			...this.config,
			privateKey: this.config.privateKey ? '***' : undefined,
		};
	}

	/**
	 * Test SAML connection
	 */
	async testConnection(): Promise<boolean> {
		try {
			// Validate configuration
			if (!this.validateConfiguration()) {
				return false;
			}

			// Generate test login URL to verify configuration
			const loginUrl = this.getLoginUrl();
			
			this.logger.info('SAML connection test successful', {
				entityId: this.config.entityId,
				ssoUrl: this.config.ssoUrl,
			});

			return true;
		} catch (error) {
			this.logger.error('SAML connection test failed', {
				error: error.message,
			});
			return false;
		}
	}

	/**
	 * Get pending requests (for debugging)
	 */
	getPendingRequests(): Array<{ id: string; timestamp: Date; relayState?: string }> {
		const requests = [];
		for (const [id, data] of this.pendingRequests.entries()) {
			requests.push({ id, ...data });
		}
		return requests;
	}

	// Private methods

	private generateRequestId(): string {
		return `_${randomBytes(16).toString('hex')}`;
	}

	private generateAuthnRequest(requestId: string): string {
		const timestamp = new Date().toISOString();
		const acsUrl = `${this.getBaseUrl()}/auth/saml/callback`;

		return `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${timestamp}" Destination="${this.config.ssoUrl}" AssertionConsumerServiceURL="${acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>${this.config.entityId}</saml:Issuer>
  ${!this.config.disableRequestedAuthnContext ? 
    `<samlp:RequestedAuthnContext Comparison="exact">
      <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>
    </samlp:RequestedAuthnContext>` : ''}
</samlp:AuthnRequest>`;
	}

	private generateLogoutRequest(requestId: string, nameId?: string, sessionIndex?: string): string {
		const timestamp = new Date().toISOString();

		return `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${timestamp}" Destination="${this.config.sloUrl}">
  <saml:Issuer>${this.config.entityId}</saml:Issuer>
  ${nameId ? `<saml:NameID Format="${this.config.nameIdFormat}">${nameId}</saml:NameID>` : ''}
  ${sessionIndex ? `<samlp:SessionIndex>${sessionIndex}</samlp:SessionIndex>` : ''}
</samlp:LogoutRequest>`;
	}

	private generateKeyDescriptor(): string {
		// This would include the public key for verification
		return `<KeyDescriptor use="signing">
  <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
    <ds:X509Data>
      <ds:X509Certificate>${this.config.certificate}</ds:X509Certificate>
    </ds:X509Data>
  </ds:KeyInfo>
</KeyDescriptor>`;
	}

	private signRequest(samlRequest: string, relayState?: string): string {
		// In real implementation, this would use the private key to sign the request
		// For this community edition, we'll return a placeholder signature
		const dataToSign = `SAMLRequest=${encodeURIComponent(samlRequest)}${relayState ? `&RelayState=${encodeURIComponent(relayState)}` : ''}&SigAlg=${encodeURIComponent(`http://www.w3.org/2001/04/xmldsig-more#rsa-${this.config.signatureAlgorithm}`)}`;
		
		return createHash(this.config.signatureAlgorithm).update(dataToSign).digest('base64');
	}

	private async validateSamlResponse(response: any): Promise<void> {
		// Validate response structure
		if (!response.response || !response.response.assertion) {
			throw new Error('Invalid SAML response structure');
		}

		const assertion = response.response.assertion[0];
		
		// Check if assertion is present
		if (!assertion) {
			throw new Error('No assertion found in SAML response');
		}

		// Validate InResponseTo if required
		if (this.config.validateInResponseTo) {
			const inResponseTo = response.response.$.InResponseTo;
			if (inResponseTo && !this.pendingRequests.has(inResponseTo)) {
				throw new Error('Invalid InResponseTo value in SAML response');
			}
			
			// Remove validated request
			if (inResponseTo) {
				this.pendingRequests.delete(inResponseTo);
			}
		}

		// Validate timestamps
		const conditions = assertion.conditions && assertion.conditions[0];
		if (conditions) {
			const notBefore = conditions.$.NotBefore;
			const notOnOrAfter = conditions.$.NotOnOrAfter;
			const now = new Date();

			if (notBefore && new Date(notBefore) > now) {
				throw new Error('SAML assertion not yet valid');
			}

			if (notOnOrAfter && new Date(notOnOrAfter) <= now) {
				throw new Error('SAML assertion has expired');
			}
		}

		// Validate audience restriction
		const audienceRestriction = conditions && conditions.audiencerestriction && conditions.audiencerestriction[0];
		if (audienceRestriction) {
			const audiences = audienceRestriction.audience || [];
			const validAudience = audiences.some(audience => 
				audience._ === this.config.entityId || audience === this.config.entityId
			);
			
			if (!validAudience) {
				throw new Error('SAML assertion audience restriction failed');
			}
		}
	}

	private extractUserData(response: any): SamlUserData {
		const assertion = response.response.assertion[0];
		const nameId = assertion.subject[0].nameid[0]._;
		const attributes = this.extractAttributes(assertion);

		// Extract basic user info
		const email = this.getAttributeValue(attributes, this.config.emailAttribute);
		const firstName = this.getAttributeValue(attributes, this.config.firstNameAttribute);
		const lastName = this.getAttributeValue(attributes, this.config.lastNameAttribute);
		const role = this.getAttributeValue(attributes, this.config.roleAttribute);
		const groups = this.getAttributeValues(attributes, this.config.groupAttribute);

		if (!email) {
			throw new Error('Email attribute not found in SAML response');
		}

		// Map role if configured
		let mappedRole = this.config.defaultRole;
		if (role && this.config.roleMapping && this.config.roleMapping[role]) {
			mappedRole = this.config.roleMapping[role];
		}

		// Extract session info
		const authnStatement = assertion.authnstatement && assertion.authnstatement[0];
		const sessionIndex = authnStatement && authnStatement.$.SessionIndex;

		return {
			email,
			firstName,
			lastName,
			role: mappedRole,
			groups,
			attributes,
			nameId,
			sessionIndex,
		};
	}

	private extractAttributes(assertion: any): Record<string, any> {
		const attributes = {};
		const attributeStatement = assertion.attributestatement && assertion.attributestatement[0];
		
		if (attributeStatement && attributeStatement.attribute) {
			for (const attr of attributeStatement.attribute) {
				const name = attr.$.Name || attr.$.FriendlyName;
				const values = attr.attributevalue ? attr.attributevalue.map(v => v._ || v) : [];
				attributes[name] = values.length === 1 ? values[0] : values;
			}
		}

		return attributes;
	}

	private getAttributeValue(attributes: Record<string, any>, attributeName?: string): string | undefined {
		if (!attributeName || !attributes[attributeName]) {
			return undefined;
		}

		const value = attributes[attributeName];
		return Array.isArray(value) ? value[0] : value;
	}

	private getAttributeValues(attributes: Record<string, any>, attributeName?: string): string[] {
		if (!attributeName || !attributes[attributeName]) {
			return [];
		}

		const value = attributes[attributeName];
		return Array.isArray(value) ? value : [value];
	}

	private async syncUser(userData: SamlUserData): Promise<User> {
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
				// Set a placeholder password since authentication is via SAML
				password: createHash('sha256').update(Math.random().toString()).digest('hex'),
			});
		}

		return await this.userRepository.save(user);
	}

	private cleanExpiredRequests(): void {
		const now = Date.now();
		for (const [id, data] of this.pendingRequests.entries()) {
			if (now - data.timestamp.getTime() > this.config.requestIdExpirationPeriodMs) {
				this.pendingRequests.delete(id);
			}
		}
	}

	private getBaseUrl(): string {
		// In real implementation, this would get the base URL from configuration
		return this.globalConfig.baseUrl || 'http://localhost:5678';
	}

	private loadConfigFromEnvironment(): void {
		// Load configuration from environment variables
		const envConfig: Partial<SamlConfig> = {};

		if (process.env.SAML_ENABLED) {
			envConfig.enabled = process.env.SAML_ENABLED === 'true';
		}
		if (process.env.SAML_ENTITY_ID) {
			envConfig.entityId = process.env.SAML_ENTITY_ID;
		}
		if (process.env.SAML_SSO_URL) {
			envConfig.ssoUrl = process.env.SAML_SSO_URL;
		}
		if (process.env.SAML_SLO_URL) {
			envConfig.sloUrl = process.env.SAML_SLO_URL;
		}
		if (process.env.SAML_CERTIFICATE) {
			envConfig.certificate = process.env.SAML_CERTIFICATE;
		}
		if (process.env.SAML_PRIVATE_KEY) {
			envConfig.privateKey = process.env.SAML_PRIVATE_KEY;
		}

		if (Object.keys(envConfig).length > 0) {
			this.configure(envConfig);
		}
	}
}