// Community Edition Global Scopes
// Simplified scope system for open source n8n

import type { GlobalScope } from '../types';

export const GLOBAL_SCOPES: Record<string, GlobalScope[]> = {
	'global:owner': [
		'user:list', 'user:create', 'user:update', 'user:delete',
		'workflow:list', 'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:execute',
		'credential:list', 'credential:create', 'credential:read', 'credential:update', 'credential:delete',
		'execution:list', 'execution:read', 'execution:delete',
		'settings:read', 'settings:update',
		'tag:create', 'tag:read', 'tag:update', 'tag:delete',
		'variable:create', 'variable:read', 'variable:update', 'variable:delete',
	],
	'global:admin': [
		'user:list', 'user:create', 'user:update',
		'workflow:list', 'workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:execute',
		'credential:list', 'credential:create', 'credential:read', 'credential:update', 'credential:delete',
		'execution:list', 'execution:read', 'execution:delete',
		'settings:read',
		'tag:create', 'tag:read', 'tag:update', 'tag:delete',
		'variable:create', 'variable:read', 'variable:update', 'variable:delete',
	],
	'global:member': [
		'workflow:list', 'workflow:create', 'workflow:read', 'workflow:update', 'workflow:execute',
		'credential:list', 'credential:create', 'credential:read', 'credential:update',
		'execution:list', 'execution:read',
		'tag:read',
		'variable:read',
	],
};

export const WORKFLOW_SCOPES: Record<string, GlobalScope[]> = {
	'workflow:admin': [
		'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:execute'
	],
	'workflow:editor': [
		'workflow:read', 'workflow:update', 'workflow:execute'
	],
	'workflow:viewer': [
		'workflow:read'
	],
};

export const CREDENTIAL_SCOPES: Record<string, GlobalScope[]> = {
	'credential:owner': [
		'credential:read', 'credential:update', 'credential:delete'
	],
	'credential:user': [
		'credential:read'
	],
};