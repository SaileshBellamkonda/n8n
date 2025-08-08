// Community Edition Global Scope Utilities

import type { GlobalScope } from '../types';
import { GLOBAL_SCOPES } from '../roles/global-scopes';

/**
 * Check if a user has a global scope
 */
export function hasGlobalScope(userRole: string, requiredScope: GlobalScope): boolean {
	const roleScopes = GLOBAL_SCOPES[userRole];
	if (!roleScopes) return false;
	return roleScopes.includes(requiredScope);
}

/**
 * Get all global scopes for a role
 */
export function getGlobalScopes(role: string): GlobalScope[] {
	return GLOBAL_SCOPES[role] || [];
}

/**
 * Check if a role has owner-level access
 */
export function hasOwnerAccess(role: string): boolean {
	return role === 'global:owner';
}

/**
 * Check if a role has admin-level access
 */
export function hasAdminAccess(role: string): boolean {
	return role === 'global:owner' || role === 'global:admin';
}

/**
 * Get the highest role from a list of roles
 */
export function getHighestRole(roles: string[]): string {
	if (roles.includes('global:owner')) return 'global:owner';
	if (roles.includes('global:admin')) return 'global:admin';
	if (roles.includes('global:member')) return 'global:member';
	return 'global:member';
}