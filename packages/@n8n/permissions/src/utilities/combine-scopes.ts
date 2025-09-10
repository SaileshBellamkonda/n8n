// Community Edition Scope Combination Utilities

import type { GlobalScope } from '../types';

/**
 * Combine multiple scope arrays into a single unique array
 */
export function combineScopes(...scopeArrays: GlobalScope[][]): GlobalScope[] {
	const combined = new Set<GlobalScope>();
	
	for (const scopes of scopeArrays) {
		for (const scope of scopes) {
			combined.add(scope);
		}
	}
	
	return Array.from(combined);
}

/**
 * Remove duplicate scopes from an array
 */
export function deduplicateScopes(scopes: GlobalScope[]): GlobalScope[] {
	return Array.from(new Set(scopes));
}

/**
 * Check if scope array contains all required scopes
 */
export function containsAllScopes(userScopes: GlobalScope[], requiredScopes: GlobalScope[]): boolean {
	return requiredScopes.every(scope => userScopes.includes(scope));
}

/**
 * Check if scope array contains any of the required scopes
 */
export function containsAnyScope(userScopes: GlobalScope[], requiredScopes: GlobalScope[]): boolean {
	return requiredScopes.some(scope => userScopes.includes(scope));
}

/**
 * Get intersection of two scope arrays
 */
export function intersectScopes(scopes1: GlobalScope[], scopes2: GlobalScope[]): GlobalScope[] {
	return scopes1.filter(scope => scopes2.includes(scope));
}

/**
 * Get difference between two scope arrays (scopes in first but not in second)
 */
export function diffScopes(scopes1: GlobalScope[], scopes2: GlobalScope[]): GlobalScope[] {
	return scopes1.filter(scope => !scopes2.includes(scope));
}