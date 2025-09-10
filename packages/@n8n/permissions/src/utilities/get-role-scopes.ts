// Community Edition Get Role Scopes Utility

import type { GlobalScope } from '../types';
import { ROLE_DEFINITIONS } from '../roles/role-maps';

/**
 * Get all scopes for a specific role
 */
export function getRoleScopes(role: string): GlobalScope[] {
	const definition = ROLE_DEFINITIONS[role];
	return definition ? definition.scopes : [];
}

/**
 * Get scopes for multiple roles combined
 */
export function getCombinedRoleScopes(roles: string[]): GlobalScope[] {
	const allScopes = new Set<GlobalScope>();
	
	for (const role of roles) {
		const scopes = getRoleScopes(role);
		scopes.forEach(scope => allScopes.add(scope));
	}
	
	return Array.from(allScopes);
}

/**
 * Check if a role exists
 */
export function roleExists(role: string): boolean {
	return role in ROLE_DEFINITIONS;
}

/**
 * Get role definition including name and description
 */
export function getRoleDefinition(role: string) {
	return ROLE_DEFINITIONS[role];
}

/**
 * Get all available roles
 */
export function getAllRoles(): string[] {
	return Object.keys(ROLE_DEFINITIONS);
}

/**
 * Get roles by type (global, workflow, credential)
 */
export function getRolesByType(type: 'global' | 'workflow' | 'credential'): string[] {
	return Object.keys(ROLE_DEFINITIONS).filter(role => role.startsWith(type));
}