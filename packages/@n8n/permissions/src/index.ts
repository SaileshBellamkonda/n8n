// Community Edition Permissions Index
export type * from './types';
export * from './constants';

export * from './roles/global-scopes';
export * from './roles/role-maps';
export * from './roles/all-roles';

export { projectRoleSchema, globalRoleSchema, workflowRoleSchema, credentialRoleSchema } from './schemas';

export { hasScope, hasAnyScope, hasAllScopes, getUserScopes, isAdminOrOwner, isOwner, hasAdminPrivileges } from './utilities/has-scope';
export { hasGlobalScope, getGlobalScopes, hasOwnerAccess, hasAdminAccess, getHighestRole } from './utilities/has-global-scope';
export { combineScopes, deduplicateScopes, containsAllScopes, containsAnyScope, intersectScopes, diffScopes } from './utilities/combine-scopes';
export { rolesWithScope, rolesWithAnyScope, rolesWithAllScopes, getMinimumRoleForScope, isHigherRole } from './utilities/roles-with-scope';
export { getGlobalScopes as getGlobalScopesUtil, getAllGlobalScopes, getGlobalScopesByCategory, isGlobalScope } from './utilities/get-global-scopes';
export { getRoleScopes, getCombinedRoleScopes, roleExists, getRoleDefinition, getAllRoles, getRolesByType } from './utilities/get-role-scopes';
export { getResourcePermissions, hasResourcePermission, grantResourcePermission, revokeResourcePermission } from './utilities/get-resource-permissions';
export type { PermissionsRecord } from './utilities/get-resource-permissions';
export * from './public-api-permissions';
