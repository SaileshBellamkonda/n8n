import { GLOBAL_SCOPES, WORKFLOW_SCOPES, CREDENTIAL_SCOPES } from './global-scopes';
import { getRoleScopes } from '../utilities/get-role-scopes';
import type { GlobalScope } from '../types';

export interface RoleObject {
	role: string;
	name: string;
	scopes: GlobalScope[];
	licensed: boolean;
}

export interface AllRolesMap {
	global: RoleObject[];
	workflow: RoleObject[];
	credential: RoleObject[];
}

const ROLE_NAMES: Record<string, string> = {
	'global:owner': 'Owner',
	'global:admin': 'Admin',
	'global:member': 'Member',
	'workflow:admin': 'Workflow Admin',
	'workflow:editor': 'Workflow Editor',
	'workflow:viewer': 'Workflow Viewer',
	'credential:owner': 'Credential Owner',
	'credential:user': 'Credential User',
};

const mapToRoleObject = (roles: Record<string, GlobalScope[]>): RoleObject[] =>
	Object.keys(roles).map((role) => ({
		role,
		name: ROLE_NAMES[role] || role,
		scopes: getRoleScopes(role),
		licensed: false,
	}));

export const ALL_ROLES: AllRolesMap = {
	global: mapToRoleObject(GLOBAL_SCOPES),
	workflow: mapToRoleObject(WORKFLOW_SCOPES),
	credential: mapToRoleObject(CREDENTIAL_SCOPES),
};
