// Community Edition Resource Permissions Utilities

import type { GlobalScope, ResourcePermissions, UserPermissions } from '../types';
import { getRoleScopes } from '../roles/role-maps';

export interface PermissionsRecord {
	[resourceType: string]: {
		[resourceId: string]: {
			[permission: string]: boolean;
		};
	};
}

/**
 * Get resource-specific permissions for a user
 */
export function getResourcePermissions(
	userPermissions: UserPermissions,
	resourceType: string,
	resourceId?: string
): PermissionsRecord {
	const permissions: PermissionsRecord = {};
	
	// Initialize permissions structure
	if (!permissions[resourceType]) {
		permissions[resourceType] = {};
	}
	
	// Get global role permissions
	const globalScopes = getRoleScopes(userPermissions.globalRole);
	const canRead = globalScopes.includes(`${resourceType}:read` as GlobalScope);
	const canUpdate = globalScopes.includes(`${resourceType}:update` as GlobalScope);
	const canDelete = globalScopes.includes(`${resourceType}:delete` as GlobalScope);
	const canCreate = globalScopes.includes(`${resourceType}:create` as GlobalScope);
	
	// If specific resource ID provided, check resource-specific permissions
	if (resourceId) {
		const resourcePerms = userPermissions.resourcePermissions.find(
			p => p.resourceType === resourceType && p.resourceId === resourceId
		);
		
		if (!permissions[resourceType][resourceId]) {
			permissions[resourceType][resourceId] = {};
		}
		
		// Combine global and resource-specific permissions
		permissions[resourceType][resourceId] = {
			read: canRead || (resourcePerms?.permission === 'read' || resourcePerms?.permission === 'write' || resourcePerms?.permission === 'admin' || resourcePerms?.permission === 'owner'),
			write: canUpdate || (resourcePerms?.permission === 'write' || resourcePerms?.permission === 'admin' || resourcePerms?.permission === 'owner'),
			delete: canDelete || (resourcePerms?.permission === 'admin' || resourcePerms?.permission === 'owner'),
			create: canCreate,
		};
	} else {
		// Return general permissions for resource type
		permissions[resourceType]['*'] = {
			read: canRead,
			write: canUpdate,
			delete: canDelete,
			create: canCreate,
		};
	}
	
	return permissions;
}

/**
 * Check if user has specific permission on resource
 */
export function hasResourcePermission(
	userPermissions: UserPermissions,
	resourceType: string,
	permission: 'read' | 'write' | 'delete' | 'create',
	resourceId?: string
): boolean {
	const permissions = getResourcePermissions(userPermissions, resourceType, resourceId);
	
	if (resourceId) {
		return permissions[resourceType]?.[resourceId]?.[permission] || false;
	} else {
		return permissions[resourceType]?.['*']?.[permission] || false;
	}
}

/**
 * Grant permission to user for specific resource
 */
export function grantResourcePermission(
	userPermissions: UserPermissions,
	resourceType: string,
	resourceId: string,
	permission: 'read' | 'write' | 'admin' | 'owner',
	grantedBy?: string
): UserPermissions {
	const existingIndex = userPermissions.resourcePermissions.findIndex(
		p => p.resourceType === resourceType && p.resourceId === resourceId
	);
	
	const newPermission: ResourcePermissions = {
		resourceType: resourceType as any,
		resourceId,
		permission,
		grantedBy,
		grantedAt: new Date(),
	};
	
	if (existingIndex >= 0) {
		userPermissions.resourcePermissions[existingIndex] = newPermission;
	} else {
		userPermissions.resourcePermissions.push(newPermission);
	}
	
	return userPermissions;
}

/**
 * Revoke permission from user for specific resource
 */
export function revokeResourcePermission(
	userPermissions: UserPermissions,
	resourceType: string,
	resourceId: string
): UserPermissions {
	userPermissions.resourcePermissions = userPermissions.resourcePermissions.filter(
		p => !(p.resourceType === resourceType && p.resourceId === resourceId)
	);
	
	return userPermissions;
}