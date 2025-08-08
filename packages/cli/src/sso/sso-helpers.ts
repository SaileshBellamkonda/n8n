// Community Edition SSO Helpers
// Simplified SSO system for community edition

import { Logger } from '@n8n/backend-common';

export type AuthenticationMethod = 'email' | 'saml' | 'ldap' | 'oauth';

export interface SsoConfig {
	enabled: boolean;
	samlEnabled: boolean;
	oidcEnabled: boolean;
	defaultAuthMethod: AuthenticationMethod;
}

/**
 * Get current authentication method (always email in community edition)
 */
export function getCurrentAuthenticationMethod(): AuthenticationMethod {
	return 'email';
}

/**
 * Check if LDAP is current authentication method (always false in community edition)
 */
export function isLdapCurrentAuthenticationMethod(): boolean {
	return false;
}

/**
 * Check if SAML is current authentication method (always false in community edition)
 */
export function isSamlCurrentAuthenticationMethod(): boolean {
	return false;
}

/**
 * Check if OIDC is current authentication method (always false in community edition)
 */
export function isOidcCurrentAuthenticationMethod(): boolean {
	return false;
}

/**
 * Check if any SSO method is enabled (always false in community edition)
 */
export function isSsoEnabled(): boolean {
	return false;
}

/**
 * Get SSO configuration (returns disabled config in community edition)
 */
export function getSsoConfig(): SsoConfig {
	return {
		enabled: false,
		samlEnabled: false,
		oidcEnabled: false,
		defaultAuthMethod: 'email',
	};
}

/**
 * Get available authentication methods (only email in community edition)
 */
export function getAvailableAuthMethods(): AuthenticationMethod[] {
	return ['email'];
}

/**
 * Check if SSO is required for user (always false in community edition)
 */
export function isSsoRequiredForUser(userEmail?: string): boolean {
	return false;
}

/**
 * Get SSO login URL (not available in community edition)
 */
export function getSsoLoginUrl(returnUrl?: string): string | null {
	return null;
}

/**
 * Validate SSO is properly configured (always returns false in community edition)
 */
export function validateSsoConfiguration(): boolean {
	return false;
}