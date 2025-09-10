// Community Edition Get Global Scopes Utility

import type { GlobalScope } from '../types';
import { GLOBAL_SCOPES } from '../roles/global-scopes';

/**
 * Get global scopes for a role
 */
export function getGlobalScopes(role: string): GlobalScope[] {
	return GLOBAL_SCOPES[role] || [];
}

/**
 * Get all available global scopes
 */
export function getAllGlobalScopes(): GlobalScope[] {
	const allScopes = new Set<GlobalScope>();
	
	for (const scopes of Object.values(GLOBAL_SCOPES)) {
		scopes.forEach(scope => allScopes.add(scope));
	}
	
	return Array.from(allScopes);
}

/**
 * Get global scopes by category
 */
export function getGlobalScopesByCategory(category: string): GlobalScope[] {
	const allScopes = getAllGlobalScopes();
	return allScopes.filter(scope => scope.startsWith(`${category}:`));
}

/**
 * Check if a scope is a global scope
 */
export function isGlobalScope(scope: string): scope is GlobalScope {
	const allScopes = getAllGlobalScopes();
	return allScopes.includes(scope as GlobalScope);
}