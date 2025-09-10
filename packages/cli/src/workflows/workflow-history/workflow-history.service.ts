import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import type { User, WorkflowEntity } from '@n8n/db';
import { WorkflowRepository } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { GlobalConfig } from '@n8n/config';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';

const execAsync = promisify(exec);

export interface WorkflowVersion {
	id: string;
	workflowId: string;
	versionNumber: number;
	commitHash: string;
	branchName: string;
	tagName?: string;
	name: string;
	nodes: any[];
	connections: any;
	settings: Record<string, any>;
	createdAt: Date;
	createdBy: string;
	description?: string;
	tags?: string[];
	changelog?: string;
	metadata: {
		nodeCount: number;
		connectionCount: number;
		credentialCount: number;
		variableCount: number;
		triggerCount: number;
		executionCount?: number;
		lastExecutionAt?: Date;
		fileSize: number;
		checksum: string;
	};
}

export interface WorkflowHistoryQuery {
	workflowId: string;
	branchName?: string;
	fromDate?: Date;
	toDate?: Date;
	createdBy?: string;
	limit?: number;
	offset?: number;
	orderBy?: 'createdAt' | 'versionNumber' | 'name';
	orderDirection?: 'ASC' | 'DESC';
	includeTags?: boolean;
	includeMetadata?: boolean;
}

export interface WorkflowBranch {
	name: string;
	isDefault: boolean;
	lastCommitHash: string;
	lastCommitAt: Date;
	lastCommitBy: string;
	versionCount: number;
	isActive: boolean;
	description?: string;
	protectionRules?: {
		requirePullRequest: boolean;
		requireCodeReview: boolean;
		allowForcePush: boolean;
		restrictedUsers: string[];
	};
}

export interface WorkflowDiff {
	version1: string;
	version2: string;
	differences: {
		type: 'added' | 'removed' | 'modified';
		path: string;
		oldValue?: any;
		newValue?: any;
		description: string;
	}[];
	summary: {
		nodesAdded: number;
		nodesRemoved: number;
		nodesModified: number;
		connectionsAdded: number;
		connectionsRemoved: number;
		settingsChanged: number;
	};
}

export interface WorkflowMergeRequest {
	id: string;
	workflowId: string;
	sourceBranch: string;
	targetBranch: string;
	title: string;
	description?: string;
	status: 'open' | 'merged' | 'closed' | 'draft';
	createdBy: string;
	createdAt: Date;
	updatedAt: Date;
	reviewers: string[];
	approvals: string[];
	conflicts: boolean;
	changedFiles: number;
	additions: number;
	deletions: number;
}

export interface GitConfig {
	enabled: boolean;
	repositoryPath: string;
	remoteUrl?: string;
	defaultBranch: string;
	autoCommit: boolean;
	commitMessageTemplate: string;
	enableBranchProtection: boolean;
	requirePullRequest: boolean;
	enableHooks: boolean;
	maxVersionsPerWorkflow: number;
	compressionEnabled: boolean;
	enableBackup: boolean;
	backupInterval: number;
	cleanupOldVersions: boolean;
	retentionDays: number;
}

@Injectable()
export class WorkflowHistoryService {
	private config: GitConfig = {
		enabled: true, // Enable Git versioning in community edition
		repositoryPath: '/tmp/n8n-workflows',
		defaultBranch: 'main',
		autoCommit: true,
		commitMessageTemplate: 'feat(workflow): {{action}} workflow "{{name}}" by {{user}}',
		enableBranchProtection: true,
		requirePullRequest: false,
		enableHooks: true,
		maxVersionsPerWorkflow: 1000,
		compressionEnabled: true,
		enableBackup: false,
		backupInterval: 86400000, // 24 hours
		cleanupOldVersions: true,
		retentionDays: 365,
	};

	private gitInitialized = false;
	private branches = new Map<string, WorkflowBranch>();

	constructor(
		private readonly logger: Logger,
		private readonly workflowRepository: WorkflowRepository,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('workflow-history');
		this.loadConfigFromEnvironment();
	}

	/**
	 * Check if workflow history is enabled
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Configure workflow history settings
	 */
	configure(config: Partial<GitConfig>): void {
		this.config = { ...this.config, ...config };
		this.logger.info('Workflow history configuration updated', {
			enabled: this.config.enabled,
			repositoryPath: this.config.repositoryPath,
			defaultBranch: this.config.defaultBranch,
			autoCommit: this.config.autoCommit,
		});
	}

	/**
	 * Initialize Git repository
	 */
	async initialize(): Promise<void> {
		if (!this.isEnabled()) {
			this.logger.info('Workflow history is disabled');
			return;
		}

		try {
			// Ensure repository directory exists
			await fs.mkdir(this.config.repositoryPath, { recursive: true });

			// Initialize Git repository if it doesn't exist
			const gitDir = join(this.config.repositoryPath, '.git');
			try {
				await fs.access(gitDir);
				this.logger.debug('Git repository already exists');
			} catch {
				await this.initializeGitRepository();
			}

			// Setup Git configuration
			await this.setupGitConfig();

			// Initialize default branch
			await this.initializeDefaultBranch();

			this.gitInitialized = true;

			this.logger.info('Workflow history initialized successfully', {
				repositoryPath: this.config.repositoryPath,
				defaultBranch: this.config.defaultBranch,
			});
		} catch (error) {
			this.logger.error('Failed to initialize workflow history', {
				error: error.message,
				stack: error.stack,
			});
			throw error;
		}
	}

	/**
	 * Save workflow version
	 */
	async saveVersion(
		workflow: WorkflowEntity,
		user: User,
		description?: string,
		branchName?: string,
		tagName?: string
	): Promise<string> {
		if (!this.isEnabled() || !this.gitInitialized) {
			throw new BadRequestError('Workflow history is not enabled or initialized');
		}

		try {
			const branch = branchName || this.config.defaultBranch;
			const workflowPath = this.getWorkflowPath(workflow.id);

			// Ensure we're on the correct branch
			await this.switchToBranch(branch);

			// Generate workflow file content
			const workflowContent = this.generateWorkflowContent(workflow);
			const contentHash = this.generateChecksum(workflowContent);

			// Write workflow file
			await fs.writeFile(workflowPath, workflowContent, 'utf8');

			// Add metadata file
			const metadata = this.generateWorkflowMetadata(workflow, user, contentHash);
			const metadataPath = this.getWorkflowMetadataPath(workflow.id);
			await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

			// Git add, commit, and optionally tag
			await this.execGit(['add', workflowPath, metadataPath]);

			const commitMessage = this.generateCommitMessage('update', workflow.name, user.email, description);
			const commitResult = await this.execGit(['commit', '-m', commitMessage]);
			const commitHash = await this.getLastCommitHash();

			// Create tag if specified
			if (tagName) {
				await this.createTag(tagName, `Version ${tagName} of workflow "${workflow.name}"`, commitHash);
			}

			// Get version number
			const versionNumber = await this.getVersionCount(workflow.id) + 1;

			this.logger.info('Workflow version saved', {
				workflowId: workflow.id,
				versionNumber,
				commitHash,
				branch,
				tagName,
				user: user.email,
			});

			return `${workflow.id}-v${versionNumber}-${commitHash.substring(0, 8)}`;
		} catch (error) {
			this.logger.error('Failed to save workflow version', {
				workflowId: workflow.id,
				error: error.message,
			});
			throw new BadRequestError(`Failed to save workflow version: ${error.message}`);
		}
	}

	/**
	 * Get workflow versions
	 */
	async getVersions(query: WorkflowHistoryQuery): Promise<WorkflowVersion[]> {
		if (!this.isEnabled() || !this.gitInitialized) {
			throw new BadRequestError('Workflow history is not enabled or initialized');
		}

		try {
			const branch = query.branchName || this.config.defaultBranch;
			await this.switchToBranch(branch);

			// Get Git log for the workflow file
			const workflowPath = this.getWorkflowPath(query.workflowId);
			const logArgs = ['log', '--pretty=format:%H|%ct|%an|%ae|%s', '--'];
			
			if (query.fromDate) {
				logArgs.push(`--since=${Math.floor(query.fromDate.getTime() / 1000)}`);
			}
			if (query.toDate) {
				logArgs.push(`--until=${Math.floor(query.toDate.getTime() / 1000)}`);
			}
			if (query.createdBy) {
				logArgs.push(`--author=${query.createdBy}`);
			}

			logArgs.push(workflowPath);

			const { stdout } = await this.execGit(logArgs);
			const commits = stdout.trim().split('\n').filter(line => line);

			const versions: WorkflowVersion[] = [];
			let versionNumber = commits.length;

			for (const commitLine of commits) {
				const [commitHash, timestamp, authorName, authorEmail, subject] = commitLine.split('|');
				
				// Get workflow content at this commit
				const workflowContent = await this.getWorkflowContentAtCommit(query.workflowId, commitHash);
				if (!workflowContent) continue;

				// Get metadata at this commit
				const metadata = await this.getWorkflowMetadataAtCommit(query.workflowId, commitHash);

				const version: WorkflowVersion = {
					id: `${query.workflowId}-v${versionNumber}-${commitHash.substring(0, 8)}`,
					workflowId: query.workflowId,
					versionNumber,
					commitHash,
					branchName: branch,
					name: workflowContent.name,
					nodes: workflowContent.nodes,
					connections: workflowContent.connections,
					settings: workflowContent.settings,
					createdAt: new Date(parseInt(timestamp) * 1000),
					createdBy: authorEmail,
					description: this.extractDescriptionFromCommit(subject),
					metadata: metadata || this.generateWorkflowMetadata(workflowContent, { email: authorEmail } as User, ''),
				};

				// Add tags if requested
				if (query.includeTags) {
					version.tags = await this.getTagsForCommit(commitHash);
				}

				versions.push(version);
				versionNumber--;
			}

			// Apply pagination and sorting
			const sortedVersions = this.sortVersions(versions, query.orderBy, query.orderDirection);
			const offset = query.offset || 0;
			const limit = query.limit || 100;

			return sortedVersions.slice(offset, offset + limit);
		} catch (error) {
			this.logger.error('Failed to get workflow versions', {
				workflowId: query.workflowId,
				error: error.message,
			});
			throw new BadRequestError(`Failed to get workflow versions: ${error.message}`);
		}
	}

	/**
	 * Get specific workflow version
	 */
	async getVersion(versionId: string): Promise<WorkflowVersion | null> {
		if (!this.isEnabled() || !this.gitInitialized) {
			throw new BadRequestError('Workflow history is not enabled or initialized');
		}

		try {
			// Parse version ID
			const parts = versionId.split('-');
			if (parts.length < 3) {
				throw new BadRequestError('Invalid version ID format');
			}

			const workflowId = parts.slice(0, -2).join('-');
			const commitHashPrefix = parts[parts.length - 1];

			// Find full commit hash
			const { stdout } = await this.execGit(['log', '--pretty=format:%H', '--grep', commitHashPrefix]);
			const commitHash = stdout.split('\n').find(hash => hash.startsWith(commitHashPrefix));

			if (!commitHash) {
				return null;
			}

			// Get workflow content at this commit
			const workflowContent = await this.getWorkflowContentAtCommit(workflowId, commitHash);
			if (!workflowContent) {
				return null;
			}

			// Get commit info
			const { stdout: commitInfo } = await this.execGit([
				'show', '--pretty=format:%ct|%an|%ae|%s', '--no-patch', commitHash
			]);
			const [timestamp, authorName, authorEmail, subject] = commitInfo.split('|');

			// Get metadata at this commit
			const metadata = await this.getWorkflowMetadataAtCommit(workflowId, commitHash);

			const version: WorkflowVersion = {
				id: versionId,
				workflowId,
				versionNumber: 0, // Would calculate from Git log
				commitHash,
				branchName: await this.getCurrentBranch(),
				name: workflowContent.name,
				nodes: workflowContent.nodes,
				connections: workflowContent.connections,
				settings: workflowContent.settings,
				createdAt: new Date(parseInt(timestamp) * 1000),
				createdBy: authorEmail,
				description: this.extractDescriptionFromCommit(subject),
				tags: await this.getTagsForCommit(commitHash),
				metadata: metadata || this.generateWorkflowMetadata(workflowContent, { email: authorEmail } as User, ''),
			};

			return version;
		} catch (error) {
			this.logger.error('Failed to get workflow version', {
				versionId,
				error: error.message,
			});
			return null;
		}
	}

	/**
	 * Restore workflow to specific version
	 */
	async restoreVersion(workflowId: string, versionId: string, user: User): Promise<void> {
		if (!this.isEnabled() || !this.gitInitialized) {
			throw new BadRequestError('Workflow history is not enabled or initialized');
		}

		try {
			// Get the version to restore
			const version = await this.getVersion(versionId);
			if (!version) {
				throw new NotFoundError('Workflow version not found');
			}

			// Update workflow in database
			const workflow = await this.workflowRepository.findOne({
				where: { id: workflowId }
			});

			if (!workflow) {
				throw new NotFoundError('Workflow not found');
			}

			// Update workflow with version data
			workflow.name = version.name;
			workflow.nodes = version.nodes;
			workflow.connections = version.connections;
			workflow.settings = version.settings;

			await this.workflowRepository.save(workflow);

			// Save as new version (restoration)
			await this.saveVersion(
				workflow,
				user,
				`Restored from version ${versionId}`,
				undefined,
				`restore-${versionId}`
			);

			this.logger.info('Workflow restored to version', {
				workflowId,
				versionId,
				user: user.email,
			});
		} catch (error) {
			this.logger.error('Failed to restore workflow version', {
				workflowId,
				versionId,
				error: error.message,
			});
			throw new BadRequestError(`Failed to restore workflow version: ${error.message}`);
		}
	}

	/**
	 * Compare two workflow versions
	 */
	async compareVersions(versionId1: string, versionId2: string): Promise<WorkflowDiff> {
		if (!this.isEnabled() || !this.gitInitialized) {
			throw new BadRequestError('Workflow history is not enabled or initialized');
		}

		try {
			const version1 = await this.getVersion(versionId1);
			const version2 = await this.getVersion(versionId2);

			if (!version1 || !version2) {
				throw new NotFoundError('One or both versions not found');
			}

			// Compare workflows
			const differences = this.compareWorkflows(version1, version2);
			const summary = this.generateDiffSummary(differences);

			return {
				version1: versionId1,
				version2: versionId2,
				differences,
				summary,
			};
		} catch (error) {
			this.logger.error('Failed to compare workflow versions', {
				versionId1,
				versionId2,
				error: error.message,
			});
			throw new BadRequestError(`Failed to compare workflow versions: ${error.message}`);
		}
	}

	/**
	 * Create workflow branch
	 */
	async createBranch(workflowId: string, branchName: string, sourceBranch?: string, user?: User): Promise<WorkflowBranch> {
		if (!this.isEnabled() || !this.gitInitialized) {
			throw new BadRequestError('Workflow history is not enabled or initialized');
		}

		try {
			const source = sourceBranch || this.config.defaultBranch;

			// Create Git branch
			await this.execGit(['checkout', '-b', branchName, source]);

			// Create branch metadata
			const branch: WorkflowBranch = {
				name: branchName,
				isDefault: false,
				lastCommitHash: await this.getLastCommitHash(),
				lastCommitAt: new Date(),
				lastCommitBy: user?.email || 'system',
				versionCount: 0,
				isActive: true,
			};

			this.branches.set(branchName, branch);

			this.logger.info('Workflow branch created', {
				workflowId,
				branchName,
				sourceBranch: source,
				user: user?.email,
			});

			return branch;
		} catch (error) {
			this.logger.error('Failed to create workflow branch', {
				workflowId,
				branchName,
				error: error.message,
			});
			throw new BadRequestError(`Failed to create workflow branch: ${error.message}`);
		}
	}

	/**
	 * Get workflow branches
	 */
	async getBranches(workflowId: string): Promise<WorkflowBranch[]> {
		if (!this.isEnabled() || !this.gitInitialized) {
			throw new BadRequestError('Workflow history is not enabled or initialized');
		}

		try {
			// Get Git branches
			const { stdout } = await this.execGit(['branch', '-a']);
			const branchLines = stdout.split('\n').filter(line => line.trim());

			const branches: WorkflowBranch[] = [];

			for (const line of branchLines) {
				const branchName = line.replace(/^\*?\s*/, '').replace(/^origin\//, '');
				if (branchName === 'HEAD') continue;

				const isDefault = branchName === this.config.defaultBranch;
				const lastCommitHash = await this.getLastCommitHashForBranch(branchName);
				const lastCommitInfo = await this.getCommitInfo(lastCommitHash);

				const branch: WorkflowBranch = {
					name: branchName,
					isDefault,
					lastCommitHash,
					lastCommitAt: lastCommitInfo.date,
					lastCommitBy: lastCommitInfo.author,
					versionCount: await this.getVersionCountForBranch(workflowId, branchName),
					isActive: true,
				};

				branches.push(branch);
			}

			return branches;
		} catch (error) {
			this.logger.error('Failed to get workflow branches', {
				workflowId,
				error: error.message,
			});
			throw new BadRequestError(`Failed to get workflow branches: ${error.message}`);
		}
	}

	/**
	 * Delete workflow version
	 */
	async deleteVersion(versionId: string): Promise<void> {
		if (!this.isEnabled() || !this.gitInitialized) {
			throw new BadRequestError('Workflow history is not enabled or initialized');
		}

		// Note: In Git, we typically don't delete individual commits
		// Instead, we might revert or mark as deleted
		this.logger.warn('Workflow version deletion is not recommended with Git versioning', {
			versionId,
		});

		throw new BadRequestError('Individual version deletion is not supported with Git versioning. Consider reverting changes instead.');
	}

	/**
	 * Get version count for workflow
	 */
	async getVersionCount(workflowId: string, branchName?: string): Promise<number> {
		if (!this.isEnabled() || !this.gitInitialized) {
			return 0;
		}

		try {
			const branch = branchName || this.config.defaultBranch;
			const workflowPath = this.getWorkflowPath(workflowId);

			const { stdout } = await this.execGit(['rev-list', '--count', `${branch}`, '--', workflowPath]);
			return parseInt(stdout.trim()) || 0;
		} catch (error) {
			this.logger.error('Failed to get version count', {
				workflowId,
				branchName,
				error: error.message,
			});
			return 0;
		}
	}

	/**
	 * Cleanup old versions
	 */
	async cleanupOldVersions(workflowId: string, keepCount: number = 50): Promise<void> {
		if (!this.config.cleanupOldVersions) {
			this.logger.debug('Version cleanup is disabled');
			return;
		}

		// Git cleanup would involve garbage collection and tag management
		// For safety, we'll log this action without actual deletion
		this.logger.info('Version cleanup requested', {
			workflowId,
			keepCount,
			note: 'Git maintains full history; cleanup involves tag and branch management',
		});
	}

	// Private helper methods

	private async initializeGitRepository(): Promise<void> {
		await this.execGit(['init']);
		this.logger.info('Git repository initialized', {
			path: this.config.repositoryPath,
		});
	}

	private async setupGitConfig(): Promise<void> {
		try {
			await this.execGit(['config', 'user.name', 'n8n Workflow System']);
			await this.execGit(['config', 'user.email', 'workflows@n8n.io']);
			await this.execGit(['config', 'init.defaultBranch', this.config.defaultBranch]);
		} catch (error) {
			this.logger.warn('Failed to setup Git config', { error: error.message });
		}
	}

	private async initializeDefaultBranch(): Promise<void> {
		try {
			// Check if we have any commits
			await this.execGit(['rev-parse', 'HEAD']);
		} catch {
			// No commits yet, create initial commit
			const readmePath = join(this.config.repositoryPath, 'README.md');
			await fs.writeFile(readmePath, '# n8n Workflow History\n\nThis repository contains workflow version history.\n');
			await this.execGit(['add', 'README.md']);
			await this.execGit(['commit', '-m', 'Initial commit']);
		}

		// Ensure we're on the default branch
		await this.switchToBranch(this.config.defaultBranch);
	}

	private async switchToBranch(branchName: string): Promise<void> {
		try {
			await this.execGit(['checkout', branchName]);
		} catch {
			// Branch doesn't exist, create it
			await this.execGit(['checkout', '-b', branchName]);
		}
	}

	private async execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
		const command = `git ${args.join(' ')}`;
		return await execAsync(command, { cwd: this.config.repositoryPath });
	}

	private getWorkflowPath(workflowId: string): string {
		return join(this.config.repositoryPath, 'workflows', `${workflowId}.json`);
	}

	private getWorkflowMetadataPath(workflowId: string): string {
		return join(this.config.repositoryPath, 'workflows', `${workflowId}.metadata.json`);
	}

	private generateWorkflowContent(workflow: WorkflowEntity): string {
		const content = {
			id: workflow.id,
			name: workflow.name,
			nodes: workflow.nodes,
			connections: workflow.connections,
			settings: workflow.settings,
			createdAt: workflow.createdAt,
			updatedAt: workflow.updatedAt,
		};

		return JSON.stringify(content, null, 2);
	}

	private generateWorkflowMetadata(workflow: any, user: User, checksum: string): any {
		const nodeTypes = new Set();
		const triggerCount = workflow.nodes?.filter((node: any) => node.type.includes('Trigger')).length || 0;

		workflow.nodes?.forEach((node: any) => {
			nodeTypes.add(node.type);
		});

		return {
			nodeCount: workflow.nodes?.length || 0,
			connectionCount: Object.keys(workflow.connections || {}).length,
			credentialCount: 0, // Would calculate from nodes
			variableCount: 0, // Would calculate from nodes
			triggerCount,
			fileSize: JSON.stringify(workflow).length,
			checksum,
			nodeTypes: Array.from(nodeTypes),
			lastModifiedBy: user.email,
			lastModifiedAt: new Date().toISOString(),
		};
	}

	private generateChecksum(content: string): string {
		return createHash('sha256').update(content).digest('hex');
	}

	private generateCommitMessage(action: string, workflowName: string, userEmail: string, description?: string): string {
		let message = this.config.commitMessageTemplate
			.replace('{{action}}', action)
			.replace('{{name}}', workflowName)
			.replace('{{user}}', userEmail);

		if (description) {
			message += `\n\n${description}`;
		}

		return message;
	}

	private async getLastCommitHash(): Promise<string> {
		const { stdout } = await this.execGit(['rev-parse', 'HEAD']);
		return stdout.trim();
	}

	private async getCurrentBranch(): Promise<string> {
		const { stdout } = await this.execGit(['branch', '--show-current']);
		return stdout.trim();
	}

	private async getWorkflowContentAtCommit(workflowId: string, commitHash: string): Promise<any> {
		try {
			const workflowPath = this.getWorkflowPath(workflowId);
			const { stdout } = await this.execGit(['show', `${commitHash}:${workflowPath}`]);
			return JSON.parse(stdout);
		} catch {
			return null;
		}
	}

	private async getWorkflowMetadataAtCommit(workflowId: string, commitHash: string): Promise<any> {
		try {
			const metadataPath = this.getWorkflowMetadataPath(workflowId);
			const { stdout } = await this.execGit(['show', `${commitHash}:${metadataPath}`]);
			return JSON.parse(stdout);
		} catch {
			return null;
		}
	}

	private extractDescriptionFromCommit(subject: string): string {
		// Extract meaningful description from commit subject
		const match = subject.match(/feat\(workflow\): \w+ workflow "(.+)" by .+/);
		return match ? `Updated workflow: ${match[1]}` : subject;
	}

	private async getTagsForCommit(commitHash: string): Promise<string[]> {
		try {
			const { stdout } = await this.execGit(['tag', '--points-at', commitHash]);
			return stdout.trim().split('\n').filter(tag => tag);
		} catch {
			return [];
		}
	}

	private async createTag(tagName: string, message: string, commitHash: string): Promise<void> {
		await this.execGit(['tag', '-a', tagName, '-m', message, commitHash]);
	}

	private sortVersions(versions: WorkflowVersion[], orderBy?: string, orderDirection?: string): WorkflowVersion[] {
		const direction = orderDirection === 'DESC' ? -1 : 1;

		return versions.sort((a, b) => {
			let comparison = 0;

			switch (orderBy) {
				case 'versionNumber':
					comparison = a.versionNumber - b.versionNumber;
					break;
				case 'name':
					comparison = a.name.localeCompare(b.name);
					break;
				case 'createdAt':
				default:
					comparison = a.createdAt.getTime() - b.createdAt.getTime();
					break;
			}

			return comparison * direction;
		});
	}

	private compareWorkflows(version1: WorkflowVersion, version2: WorkflowVersion): any[] {
		const differences = [];

		// Compare nodes
		const nodes1 = new Map(version1.nodes.map(node => [node.id, node]));
		const nodes2 = new Map(version2.nodes.map(node => [node.id, node]));

		// Find added nodes
		for (const [nodeId, node] of nodes2) {
			if (!nodes1.has(nodeId)) {
				differences.push({
					type: 'added',
					path: `nodes.${nodeId}`,
					newValue: node,
					description: `Added node: ${node.name} (${node.type})`,
				});
			}
		}

		// Find removed nodes
		for (const [nodeId, node] of nodes1) {
			if (!nodes2.has(nodeId)) {
				differences.push({
					type: 'removed',
					path: `nodes.${nodeId}`,
					oldValue: node,
					description: `Removed node: ${node.name} (${node.type})`,
				});
			}
		}

		// Find modified nodes
		for (const [nodeId, node1] of nodes1) {
			const node2 = nodes2.get(nodeId);
			if (node2 && JSON.stringify(node1) !== JSON.stringify(node2)) {
				differences.push({
					type: 'modified',
					path: `nodes.${nodeId}`,
					oldValue: node1,
					newValue: node2,
					description: `Modified node: ${node1.name} (${node1.type})`,
				});
			}
		}

		// Compare connections, settings, etc. (similar logic)

		return differences;
	}

	private generateDiffSummary(differences: any[]): any {
		return {
			nodesAdded: differences.filter(d => d.type === 'added' && d.path.startsWith('nodes.')).length,
			nodesRemoved: differences.filter(d => d.type === 'removed' && d.path.startsWith('nodes.')).length,
			nodesModified: differences.filter(d => d.type === 'modified' && d.path.startsWith('nodes.')).length,
			connectionsAdded: differences.filter(d => d.type === 'added' && d.path.startsWith('connections.')).length,
			connectionsRemoved: differences.filter(d => d.type === 'removed' && d.path.startsWith('connections.')).length,
			settingsChanged: differences.filter(d => d.path.startsWith('settings.')).length,
		};
	}

	private async getLastCommitHashForBranch(branchName: string): Promise<string> {
		const { stdout } = await this.execGit(['rev-parse', branchName]);
		return stdout.trim();
	}

	private async getCommitInfo(commitHash: string): Promise<{ date: Date; author: string }> {
		const { stdout } = await this.execGit(['show', '--pretty=format:%ct|%ae', '--no-patch', commitHash]);
		const [timestamp, author] = stdout.split('|');
		return {
			date: new Date(parseInt(timestamp) * 1000),
			author,
		};
	}

	private async getVersionCountForBranch(workflowId: string, branchName: string): Promise<number> {
		return await this.getVersionCount(workflowId, branchName);
	}

	private loadConfigFromEnvironment(): void {
		// Load configuration from environment variables
		const envConfig: Partial<GitConfig> = {};

		if (process.env.WORKFLOW_HISTORY_ENABLED) {
			envConfig.enabled = process.env.WORKFLOW_HISTORY_ENABLED === 'true';
		}
		if (process.env.WORKFLOW_HISTORY_REPOSITORY_PATH) {
			envConfig.repositoryPath = process.env.WORKFLOW_HISTORY_REPOSITORY_PATH;
		}
		if (process.env.WORKFLOW_HISTORY_DEFAULT_BRANCH) {
			envConfig.defaultBranch = process.env.WORKFLOW_HISTORY_DEFAULT_BRANCH;
		}
		if (process.env.WORKFLOW_HISTORY_AUTO_COMMIT) {
			envConfig.autoCommit = process.env.WORKFLOW_HISTORY_AUTO_COMMIT === 'true';
		}
		if (process.env.WORKFLOW_HISTORY_RETENTION_DAYS) {
			envConfig.retentionDays = parseInt(process.env.WORKFLOW_HISTORY_RETENTION_DAYS, 10);
		}

		if (Object.keys(envConfig).length > 0) {
			this.configure(envConfig);
		}
	}
}