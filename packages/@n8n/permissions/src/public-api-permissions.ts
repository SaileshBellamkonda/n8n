// Community Edition Public API Permissions
// Simplified API permission system

import type { GlobalScope } from './types';

export const PUBLIC_API_SCOPES: Record<string, GlobalScope[]> = {
	// User management
	'users:list': ['user:list'],
	'users:create': ['user:create'],
	'users:update': ['user:update'],
	'users:delete': ['user:delete'],
	
	// Workflow management
	'workflows:list': ['workflow:list'],
	'workflows:create': ['workflow:create'],
	'workflows:read': ['workflow:read'],
	'workflows:update': ['workflow:update'],
	'workflows:delete': ['workflow:delete'],
	'workflows:execute': ['workflow:execute'],
	
	// Credential management
	'credentials:list': ['credential:list'],
	'credentials:create': ['credential:create'],
	'credentials:read': ['credential:read'],
	'credentials:update': ['credential:update'],
	'credentials:delete': ['credential:delete'],
	
	// Execution management
	'executions:list': ['execution:list'],
	'executions:read': ['execution:read'],
	'executions:delete': ['execution:delete'],
	
	// Settings management
	'settings:read': ['settings:read'],
	'settings:update': ['settings:update'],
	
	// Tag management
	'tags:create': ['tag:create'],
	'tags:read': ['tag:read'],
	'tags:update': ['tag:update'],
	'tags:delete': ['tag:delete'],
	
	// Variable management
	'variables:create': ['variable:create'],
	'variables:read': ['variable:read'],
	'variables:update': ['variable:update'],
	'variables:delete': ['variable:delete'],
};

/**
 * Get required scopes for a public API permission
 */
export function getApiPermissionScopes(permission: string): GlobalScope[] {
	return PUBLIC_API_SCOPES[permission] || [];
}

/**
 * Check if user role has permission for public API endpoint
 */
export function hasApiPermission(userScopes: GlobalScope[], apiPermission: string): boolean {
	const requiredScopes = getApiPermissionScopes(apiPermission);
	return requiredScopes.some(scope => userScopes.includes(scope));
}

/**
 * Get all available API permissions
 */
export function getAllApiPermissions(): string[] {
	return Object.keys(PUBLIC_API_SCOPES);
}