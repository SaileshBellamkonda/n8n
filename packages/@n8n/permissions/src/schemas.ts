// Community Edition Permission Schemas
// Simple validation schemas for permissions

import { z } from 'zod';

export const globalRoleSchema = z.enum([
	'global:owner',
	'global:admin', 
	'global:member'
]);

export const workflowRoleSchema = z.enum([
	'workflow:admin',
	'workflow:editor',
	'workflow:viewer'
]);

export const credentialRoleSchema = z.enum([
	'credential:owner',
	'credential:user'
]);

export const projectRoleSchema = z.enum([
	'project:admin',
	'project:editor', 
	'project:viewer'
]);

export const permissionSchema = z.enum([
	'read',
	'write', 
	'admin',
	'owner'
]);

export const resourceTypeSchema = z.enum([
	'workflow',
	'credential',
	'execution',
	'variable',
	'tag',
	'user',
	'settings'
]);

export const globalScopeSchema = z.enum([
	'user:list', 'user:create', 'user:update', 'user:delete',
	'workflow:list', 'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:execute',
	'credential:list', 'credential:create', 'credential:read', 'credential:update', 'credential:delete',
	'execution:list', 'execution:read', 'execution:delete',
	'settings:read', 'settings:update',
	'tag:create', 'tag:read', 'tag:update', 'tag:delete',
	'variable:create', 'variable:read', 'variable:update', 'variable:delete'
]);

export const permissionCheckSchema = z.object({
	resourceType: resourceTypeSchema,
	resourceId: z.string().optional(),
	permission: permissionSchema
});

export const userPermissionsSchema = z.object({
	userId: z.string(),
	globalRole: globalRoleSchema,
	resourcePermissions: z.array(z.object({
		resourceType: resourceTypeSchema,
		resourceId: z.string(),
		permission: permissionSchema,
		grantedBy: z.string().optional(),
		grantedAt: z.date().optional()
	}))
});