// Community Edition Permission Constants
// Simplified permission system constants

export const GLOBAL_ROLES = {
	OWNER: 'global:owner',
	ADMIN: 'global:admin', 
	MEMBER: 'global:member',
} as const;

export const SHARING_ROLES = {
	VIEWER: 'workflow:viewer',
	EDITOR: 'workflow:editor',
	ADMIN: 'workflow:admin',
} as const;

export const CREDENTIAL_ROLES = {
	OWNER: 'credential:owner',
	USER: 'credential:user',
} as const;

export const DEFAULT_SCOPES = {
	OWNER: [
		'user:list', 'user:create', 'user:update', 'user:delete',
		'workflow:list', 'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:execute',
		'credential:list', 'credential:create', 'credential:read', 'credential:update', 'credential:delete',
		'execution:list', 'execution:read', 'execution:delete',
		'settings:read', 'settings:update',
		'tag:create', 'tag:read', 'tag:update', 'tag:delete',
		'variable:create', 'variable:read', 'variable:update', 'variable:delete',
	],
	ADMIN: [
		'user:list', 'user:create', 'user:update',
		'workflow:list', 'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:execute',
		'credential:list', 'credential:create', 'credential:read', 'credential:update', 'credential:delete',
		'execution:list', 'execution:read', 'execution:delete',
		'settings:read',
		'tag:create', 'tag:read', 'tag:update', 'tag:delete',
		'variable:create', 'variable:read', 'variable:update', 'variable:delete',
	],
	MEMBER: [
		'workflow:list', 'workflow:create', 'workflow:read', 'workflow:update', 'workflow:execute',
		'credential:list', 'credential:create', 'credential:read', 'credential:update',
		'execution:list', 'execution:read',
		'tag:read',
		'variable:read',
	],
} as const;

export const RESOURCE_TYPES = {
	WORKFLOW: 'workflow',
	CREDENTIAL: 'credential',
	EXECUTION: 'execution',
	VARIABLE: 'variable',
	TAG: 'tag',
	USER: 'user',
	SETTINGS: 'settings',
} as const;