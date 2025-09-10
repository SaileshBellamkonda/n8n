// Community Edition Role Maps
// Simple role mapping system for community edition

import type { GlobalScope } from '../types';
import { GLOBAL_SCOPES, WORKFLOW_SCOPES, CREDENTIAL_SCOPES } from './global-scopes';

export interface RoleDefinition {
	name: string;
	scopes: GlobalScope[];
	description: string;
}

export const ROLE_DEFINITIONS: Record<string, RoleDefinition> = {
	'global:owner': {
		name: 'Owner',
		scopes: GLOBAL_SCOPES['global:owner'],
		description: 'Full access to all resources and settings'
	},
	'global:admin': {
		name: 'Admin',
		scopes: GLOBAL_SCOPES['global:admin'],
		description: 'Administrative access to workflows, credentials, and users'
	},
	'global:member': {
		name: 'Member',
		scopes: GLOBAL_SCOPES['global:member'],
		description: 'Basic access to create and edit workflows'
	},
	'workflow:admin': {
		name: 'Workflow Admin',
		scopes: WORKFLOW_SCOPES['workflow:admin'],
		description: 'Full access to specific workflow'
	},
	'workflow:editor': {
		name: 'Workflow Editor',
		scopes: WORKFLOW_SCOPES['workflow:editor'],
		description: 'Edit and execute specific workflow'
	},
	'workflow:viewer': {
		name: 'Workflow Viewer',
		scopes: WORKFLOW_SCOPES['workflow:viewer'],
		description: 'View-only access to specific workflow'
	},
	'credential:owner': {
		name: 'Credential Owner',
		scopes: CREDENTIAL_SCOPES['credential:owner'],
		description: 'Full access to specific credential'
	},
	'credential:user': {
		name: 'Credential User',
		scopes: CREDENTIAL_SCOPES['credential:user'],
		description: 'Use specific credential in workflows'
	},
};

export function getRoleScopes(role: string): GlobalScope[] {
	return ROLE_DEFINITIONS[role]?.scopes || [];
}

export function getAllRoles(): string[] {
	return Object.keys(ROLE_DEFINITIONS);
}

export function getRoleDefinition(role: string): RoleDefinition | undefined {
	return ROLE_DEFINITIONS[role];
}