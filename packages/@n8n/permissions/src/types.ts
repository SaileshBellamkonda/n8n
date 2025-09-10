// Community Edition Permission Types
// Simple permission system for open source n8n

export type Permission = 'read' | 'write' | 'admin' | 'owner';

export type ResourceType = 
	| 'workflow' 
	| 'credential' 
	| 'execution' 
	| 'variable'
	| 'tag'
	| 'user'
	| 'settings';

export interface PermissionCheck {
	resourceType: ResourceType;
	resourceId?: string;
	permission: Permission;
}

export interface UserPermissions {
	userId: string;
	globalRole: 'member' | 'admin' | 'owner';
	resourcePermissions: ResourcePermissions[];
}

export interface ResourcePermissions {
	resourceType: ResourceType;
	resourceId: string;
	permission: Permission;
	grantedBy?: string;
	grantedAt?: Date;
}

export type GlobalScope = 
	| 'user:list'
	| 'user:create' 
	| 'user:update'
	| 'user:delete'
	| 'workflow:list'
	| 'workflow:create'
	| 'workflow:read'
	| 'workflow:update'
	| 'workflow:delete'
	| 'workflow:execute'
	| 'credential:list'
	| 'credential:create'
	| 'credential:read'
	| 'credential:update'
	| 'credential:delete'
	| 'execution:list'
	| 'execution:read'
	| 'execution:delete'
	| 'settings:read'
	| 'settings:update'
	| 'tag:create'
	| 'tag:read'
	| 'tag:update'
	| 'tag:delete'
	| 'variable:create'
	| 'variable:read'
	| 'variable:update'
	| 'variable:delete';

export interface SharingRole {
	role: 'viewer' | 'editor' | 'admin';
	scopes: GlobalScope[];
}