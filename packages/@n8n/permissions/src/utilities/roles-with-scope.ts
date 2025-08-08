// Community Edition Roles with Scope Utilities

import type { GlobalScope } from '../types';
import { ROLE_DEFINITIONS } from '../roles/role-maps';

/**
 * Get all roles that have a specific scope
 */
export function rolesWithScope(scope: GlobalScope): string[] {
	const roles: string[] = [];
	
	for (const [role, definition] of Object.entries(ROLE_DEFINITIONS)) {
		if (definition.scopes.includes(scope)) {
			roles.push(role);
		}
	}
	
	return roles;
}

/**
 * Get all roles that have any of the specified scopes
 */
export function rolesWithAnyScope(scopes: GlobalScope[]): string[] {
	const roles: string[] = [];
	
	for (const [role, definition] of Object.entries(ROLE_DEFINITIONS)) {
		if (scopes.some(scope => definition.scopes.includes(scope))) {
			roles.push(role);
		}
	}
	
	return roles;
}

/**
 * Get all roles that have all of the specified scopes
 */
export function rolesWithAllScopes(scopes: GlobalScope[]): string[] {
	const roles: string[] = [];
	
	for (const [role, definition] of Object.entries(ROLE_DEFINITIONS)) {
		if (scopes.every(scope => definition.scopes.includes(scope))) {
			roles.push(role);
		}
	}
	
	return roles;
}

/**
 * Get the minimum role required for a scope
 */
export function getMinimumRoleForScope(scope: GlobalScope): string | null {
	const roleHierarchy = ['global:member', 'global:admin', 'global:owner'];
	
	for (const role of roleHierarchy) {
		const definition = ROLE_DEFINITIONS[role];
		if (definition && definition.scopes.includes(scope)) {
			return role;
		}
	}
	
	return null;
}

/**
 * Check if a role is higher in hierarchy than another
 */
export function isHigherRole(role1: string, role2: string): boolean {
	const hierarchy = {
		'global:owner': 3,
		'global:admin': 2,
		'global:member': 1,
	};
	
	return (hierarchy[role1] || 0) > (hierarchy[role2] || 0);
}