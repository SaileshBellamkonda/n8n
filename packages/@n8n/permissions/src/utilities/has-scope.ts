// Community Edition Permission Utilities
// Simple permission checking utilities

import type { GlobalScope } from '../types';
import { getRoleScopes } from '../roles/role-maps';

/**
 * Check if a user has a specific scope based on their role
 */
export function hasScope(userRole: string, requiredScope: GlobalScope): boolean {
	const userScopes = getRoleScopes(userRole);
	return userScopes.includes(requiredScope);
}

/**
 * Check if a user has any of the required scopes
 */
export function hasAnyScope(userRole: string, requiredScopes: GlobalScope[]): boolean {
	return requiredScopes.some(scope => hasScope(userRole, scope));
}

/**
 * Check if a user has all required scopes
 */
export function hasAllScopes(userRole: string, requiredScopes: GlobalScope[]): boolean {
	return requiredScopes.every(scope => hasScope(userRole, scope));
}

/**
 * Get all scopes for a user role
 */
export function getUserScopes(userRole: string): GlobalScope[] {
	return getRoleScopes(userRole);
}

/**
 * Check if user is admin or owner
 */
export function isAdminOrOwner(userRole: string): boolean {
	return userRole === 'global:owner' || userRole === 'global:admin';
}

/**
 * Check if user is owner
 */
export function isOwner(userRole: string): boolean {
	return userRole === 'global:owner';
}

/**
 * Check if user has administrative privileges
 */
export function hasAdminPrivileges(userRole: string): boolean {
	return isAdminOrOwner(userRole);
}