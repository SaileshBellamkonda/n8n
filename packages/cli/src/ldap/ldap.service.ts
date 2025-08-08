// Community Edition LDAP Service
// Simplified LDAP-like authentication for community edition

import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { UserRepository } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { AuthError } from '@/errors/response-errors/auth.error';

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
}

export interface LdapUser {
	username: string;
	email: string;
	firstName: string;
	lastName: string;
	dn: string;
}

@Injectable()
export class CommunityLdapService {
	private config: LdapConfig = {
		enabled: false,
		server: '',
		port: 389,
		bindDn: '',
		bindPassword: '',
		baseDn: '',
		userFilter: '(uid={{username}})',
		usernameAttribute: 'uid',
		emailAttribute: 'mail',
		firstNameAttribute: 'givenName',
		lastNameAttribute: 'sn',
	};

	constructor(
		private readonly logger: Logger,
		private readonly userRepository: UserRepository,
	) {}

	/**
	 * Check if LDAP is enabled (always false in community edition)
	 */
	isEnabled(): boolean {
		return false;
	}

	/**
	 * Configure LDAP settings (no-op in community edition)
	 */
	configure(config: Partial<LdapConfig>): void {
		this.logger.info('LDAP configuration is not available in community edition');
	}

	/**
	 * Authenticate user via LDAP (fallback to email in community edition)
	 */
	async authenticate(username: string, password: string): Promise<User | null> {
		this.logger.info('LDAP authentication is not available in community edition, falling back to email authentication');
		
		// In community edition, we don't support LDAP authentication
		// This is a placeholder that will never be called since isEnabled() returns false
		throw new BadRequestError('LDAP authentication is not available in community edition');
	}

	/**
	 * Sync LDAP user to local database (no-op in community edition)
	 */
	async syncUser(ldapUser: LdapUser): Promise<User> {
		throw new BadRequestError('LDAP user sync is not available in community edition');
	}

	/**
	 * Test LDAP connection (always fails in community edition)
	 */
	async testConnection(): Promise<boolean> {
		this.logger.info('LDAP connection testing is not available in community edition');
		return false;
	}

	/**
	 * Search LDAP users (not available in community edition)
	 */
	async searchUsers(filter?: string): Promise<LdapUser[]> {
		throw new BadRequestError('LDAP user search is not available in community edition');
	}

	/**
	 * Get LDAP configuration (returns default config in community edition)
	 */
	getConfig(): LdapConfig {
		return this.config;
	}

	/**
	 * Import users from LDAP (not available in community edition)
	 */
	async importUsers(userDns: string[]): Promise<User[]> {
		throw new BadRequestError('LDAP user import is not available in community edition');
	}
}