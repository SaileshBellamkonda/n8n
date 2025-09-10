import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import { DataSource, Repository, In, Like } from '@n8n/typeorm';
import type { User, WorkflowEntity, SharedWorkflow, SharedCredentials } from '@n8n/db';
import { UserRepository, WorkflowRepository, CredentialsRepository } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { GlobalConfig } from '@n8n/config';
import { randomBytes } from 'crypto';

export interface Project {
	id: string;
	name: string;
	description?: string;
	type: 'team' | 'personal' | 'organization';
	status: 'active' | 'inactive' | 'archived';
	settings: ProjectSettings;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string;
	ownerId: string;
	memberCount: number;
	workflowCount: number;
	credentialCount: number;
	metadata: Record<string, any>;
}

export interface ProjectSettings {
	visibility: 'private' | 'internal' | 'public';
	allowMemberInvite: boolean;
	requireApproval: boolean;
	defaultWorkflowPermission: 'read' | 'write' | 'execute';
	defaultCredentialPermission: 'read' | 'use';
	enableAuditLog: boolean;
	maxMembers?: number;
	maxWorkflows?: number;
	maxCredentials?: number;
	allowedIntegrations?: string[];
	restrictedIntegrations?: string[];
	dataRetentionDays?: number;
	enableNotifications: boolean;
	notificationSettings: {
		workflowErrors: boolean;
		memberJoined: boolean;
		workflowShared: boolean;
		credentialShared: boolean;
	};
}

export interface ProjectMember {
	id: string;
	projectId: string;
	userId: string;
	role: ProjectRole;
	permissions: ProjectPermission[];
	joinedAt: Date;
	invitedBy?: string;
	status: 'active' | 'pending' | 'inactive';
	user: {
		id: string;
		email: string;
		firstName: string;
		lastName: string;
		role: string;
	};
}

export type ProjectRole = 'owner' | 'admin' | 'member' | 'viewer' | 'contributor';

export type ProjectPermission = 
	| 'project:read' | 'project:write' | 'project:delete' | 'project:manage'
	| 'workflow:create' | 'workflow:read' | 'workflow:write' | 'workflow:delete' | 'workflow:execute'
	| 'credential:create' | 'credential:read' | 'credential:write' | 'credential:delete' | 'credential:use'
	| 'member:invite' | 'member:remove' | 'member:manage'
	| 'settings:read' | 'settings:write';

export interface ProjectInvitation {
	id: string;
	projectId: string;
	email: string;
	role: ProjectRole;
	permissions: ProjectPermission[];
	invitedBy: string;
	invitedAt: Date;
	expiresAt: Date;
	status: 'pending' | 'accepted' | 'declined' | 'expired';
	token: string;
}

export interface ProjectResource {
	type: 'workflow' | 'credential';
	id: string;
	name: string;
	permissions: string[];
	sharedAt: Date;
	sharedBy: string;
}

export interface ProjectActivity {
	id: string;
	projectId: string;
	userId: string;
	action: string;
	resourceType?: 'workflow' | 'credential' | 'member';
	resourceId?: string;
	metadata: Record<string, any>;
	createdAt: Date;
}

export interface ProjectQuery {
	type?: 'team' | 'personal' | 'organization';
	status?: 'active' | 'inactive' | 'archived';
	search?: string;
	ownerId?: string;
	memberId?: string;
	limit?: number;
	offset?: number;
	orderBy?: 'name' | 'createdAt' | 'updatedAt' | 'memberCount';
	orderDirection?: 'ASC' | 'DESC';
}

export interface ProjectCreateData {
	name: string;
	description?: string;
	type: 'team' | 'personal' | 'organization';
	settings?: Partial<ProjectSettings>;
	initialMembers?: Array<{
		email: string;
		role: ProjectRole;
		permissions?: ProjectPermission[];
	}>;
}

export interface ProjectUpdateData {
	name?: string;
	description?: string;
	settings?: Partial<ProjectSettings>;
	status?: 'active' | 'inactive' | 'archived';
}

@Injectable()
export class ProjectService {
	private readonly maxProjectsPerUser = 100;
	private readonly maxMembersPerProject = 1000;
	private readonly invitationExpiryDays = 7;

	// In-memory storage for projects (in real implementation, this would be database entities)
	private projects = new Map<string, Project>();
	private projectMembers = new Map<string, ProjectMember[]>();
	private projectInvitations = new Map<string, ProjectInvitation[]>();
	private projectActivities = new Map<string, ProjectActivity[]>();

	constructor(
		private readonly logger: Logger,
		private readonly userRepository: UserRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('project-service');
	}

	/**
	 * Create a new project
	 */
	async createProject(userId: string, data: ProjectCreateData): Promise<Project> {
		// Validate user exists
		const user = await this.userRepository.findOne({ where: { id: userId } });
		if (!user) {
			throw new NotFoundError('User not found');
		}

		// Check project limits
		const userProjects = await this.getUserProjects(userId);
		if (userProjects.length >= this.maxProjectsPerUser) {
			throw new BadRequestError(`Maximum number of projects (${this.maxProjectsPerUser}) reached`);
		}

		// Validate project name
		if (!data.name || data.name.trim().length === 0) {
			throw new BadRequestError('Project name is required');
		}

		// Check for duplicate project name for this user
		const existingProject = userProjects.find(p => p.name.toLowerCase() === data.name.toLowerCase());
		if (existingProject) {
			throw new BadRequestError('Project with this name already exists');
		}

		// Create project
		const projectId = this.generateId();
		const now = new Date();

		const defaultSettings: ProjectSettings = {
			visibility: 'private',
			allowMemberInvite: true,
			requireApproval: false,
			defaultWorkflowPermission: 'read',
			defaultCredentialPermission: 'read',
			enableAuditLog: true,
			maxMembers: this.maxMembersPerProject,
			enableNotifications: true,
			notificationSettings: {
				workflowErrors: true,
				memberJoined: true,
				workflowShared: true,
				credentialShared: true,
			},
		};

		const project: Project = {
			id: projectId,
			name: data.name.trim(),
			description: data.description?.trim(),
			type: data.type,
			status: 'active',
			settings: { ...defaultSettings, ...data.settings },
			createdAt: now,
			updatedAt: now,
			createdBy: userId,
			ownerId: userId,
			memberCount: 1, // Creator is the first member
			workflowCount: 0,
			credentialCount: 0,
			metadata: {},
		};

		this.projects.set(projectId, project);

		// Add creator as owner
		const ownerMember: ProjectMember = {
			id: this.generateId(),
			projectId,
			userId,
			role: 'owner',
			permissions: this.getAllPermissions(),
			joinedAt: now,
			status: 'active',
			user: {
				id: user.id,
				email: user.email,
				firstName: user.firstName,
				lastName: user.lastName,
				role: user.role,
			},
		};

		this.projectMembers.set(projectId, [ownerMember]);

		// Initialize other collections
		this.projectInvitations.set(projectId, []);
		this.projectActivities.set(projectId, []);

		// Add initial members if provided
		if (data.initialMembers && data.initialMembers.length > 0) {
			for (const member of data.initialMembers) {
				try {
					await this.inviteMember(projectId, userId, member.email, member.role, member.permissions);
				} catch (error) {
					this.logger.warn(`Failed to invite initial member ${member.email}`, {
						projectId,
						email: member.email,
						error: error.message,
					});
				}
			}
		}

		// Log activity
		await this.logActivity(projectId, userId, 'project:created', undefined, undefined, {
			projectName: project.name,
			projectType: project.type,
		});

		this.logger.info(`Project created: ${project.name}`, {
			projectId,
			userId,
			type: project.type,
		});

		return project;
	}

	/**
	 * Get project by ID
	 */
	async getProject(projectId: string, userId?: string): Promise<Project | null> {
		const project = this.projects.get(projectId);
		if (!project) {
			return null;
		}

		// Check if user has access to the project
		if (userId && !await this.hasProjectAccess(projectId, userId, 'project:read')) {
			throw new ForbiddenError('Access denied to this project');
		}

		// Get current counts
		project.memberCount = (this.projectMembers.get(projectId) || []).length;
		project.workflowCount = await this.getProjectWorkflowCount(projectId);
		project.credentialCount = await this.getProjectCredentialCount(projectId);

		return project;
	}

	/**
	 * Update project
	 */
	async updateProject(projectId: string, userId: string, data: ProjectUpdateData): Promise<Project> {
		const project = this.projects.get(projectId);
		if (!project) {
			throw new NotFoundError('Project not found');
		}

		// Check permissions
		if (!await this.hasProjectAccess(projectId, userId, 'project:write')) {
			throw new ForbiddenError('Insufficient permissions to update this project');
		}

		// Update project
		const updatedProject = {
			...project,
			...data,
			updatedAt: new Date(),
		};

		if (data.settings) {
			updatedProject.settings = { ...project.settings, ...data.settings };
		}

		this.projects.set(projectId, updatedProject);

		// Log activity
		await this.logActivity(projectId, userId, 'project:updated', undefined, undefined, {
			changes: data,
		});

		this.logger.info(`Project updated: ${project.name}`, {
			projectId,
			userId,
			changes: Object.keys(data),
		});

		return updatedProject;
	}

	/**
	 * Delete project
	 */
	async deleteProject(projectId: string, userId: string): Promise<void> {
		const project = this.projects.get(projectId);
		if (!project) {
			throw new NotFoundError('Project not found');
		}

		// Check permissions (only owner can delete)
		if (project.ownerId !== userId) {
			throw new ForbiddenError('Only project owner can delete the project');
		}

		// Check if project has resources
		const workflowCount = await this.getProjectWorkflowCount(projectId);
		const credentialCount = await this.getProjectCredentialCount(projectId);

		if (workflowCount > 0 || credentialCount > 0) {
			throw new BadRequestError('Cannot delete project with existing workflows or credentials');
		}

		// Remove all data
		this.projects.delete(projectId);
		this.projectMembers.delete(projectId);
		this.projectInvitations.delete(projectId);
		this.projectActivities.delete(projectId);

		this.logger.info(`Project deleted: ${project.name}`, {
			projectId,
			userId,
		});
	}

	/**
	 * Get user projects
	 */
	async getUserProjects(userId: string, query: ProjectQuery = {}): Promise<Project[]> {
		const userProjects: Project[] = [];

		for (const [projectId, project] of this.projects.entries()) {
			// Check if user is a member
			const members = this.projectMembers.get(projectId) || [];
			const isMember = members.some(m => m.userId === userId);

			if (!isMember) {
				continue;
			}

			// Apply filters
			if (query.type && project.type !== query.type) {
				continue;
			}

			if (query.status && project.status !== query.status) {
				continue;
			}

			if (query.search && !project.name.toLowerCase().includes(query.search.toLowerCase())) {
				continue;
			}

			if (query.ownerId && project.ownerId !== query.ownerId) {
				continue;
			}

			userProjects.push(project);
		}

		// Sort results
		const orderBy = query.orderBy || 'name';
		const orderDirection = query.orderDirection || 'ASC';

		userProjects.sort((a, b) => {
			let comparison = 0;
			
			switch (orderBy) {
				case 'name':
					comparison = a.name.localeCompare(b.name);
					break;
				case 'createdAt':
					comparison = a.createdAt.getTime() - b.createdAt.getTime();
					break;
				case 'updatedAt':
					comparison = a.updatedAt.getTime() - b.updatedAt.getTime();
					break;
				case 'memberCount':
					comparison = a.memberCount - b.memberCount;
					break;
			}

			return orderDirection === 'DESC' ? -comparison : comparison;
		});

		// Apply pagination
		const offset = query.offset || 0;
		const limit = query.limit || 100;

		return userProjects.slice(offset, offset + limit);
	}

	/**
	 * Invite member to project
	 */
	async inviteMember(
		projectId: string, 
		inviterId: string, 
		email: string, 
		role: ProjectRole, 
		permissions?: ProjectPermission[]
	): Promise<ProjectInvitation> {
		const project = this.projects.get(projectId);
		if (!project) {
			throw new NotFoundError('Project not found');
		}

		// Check permissions
		if (!await this.hasProjectAccess(projectId, inviterId, 'member:invite')) {
			throw new ForbiddenError('Insufficient permissions to invite members');
		}

		// Check if user already invited or is member
		const existingMembers = this.projectMembers.get(projectId) || [];
		const existingInvitations = this.projectInvitations.get(projectId) || [];

		const existingMember = existingMembers.find(m => m.user.email === email);
		if (existingMember) {
			throw new BadRequestError('User is already a member of this project');
		}

		const existingInvitation = existingInvitations.find(i => i.email === email && i.status === 'pending');
		if (existingInvitation) {
			throw new BadRequestError('User already has a pending invitation to this project');
		}

		// Check member limit
		if (existingMembers.length >= (project.settings.maxMembers || this.maxMembersPerProject)) {
			throw new BadRequestError('Project has reached maximum member limit');
		}

		// Create invitation
		const invitation: ProjectInvitation = {
			id: this.generateId(),
			projectId,
			email,
			role,
			permissions: permissions || this.getDefaultPermissionsForRole(role),
			invitedBy: inviterId,
			invitedAt: new Date(),
			expiresAt: new Date(Date.now() + this.invitationExpiryDays * 24 * 60 * 60 * 1000),
			status: 'pending',
			token: this.generateInvitationToken(),
		};

		existingInvitations.push(invitation);
		this.projectInvitations.set(projectId, existingInvitations);

		// Log activity
		await this.logActivity(projectId, inviterId, 'member:invited', 'member', undefined, {
			email,
			role,
		});

		this.logger.info(`Member invited to project: ${email}`, {
			projectId,
			inviterId,
			email,
			role,
		});

		return invitation;
	}

	/**
	 * Accept project invitation
	 */
	async acceptInvitation(token: string, userId: string): Promise<ProjectMember> {
		// Find invitation by token
		let foundInvitation: ProjectInvitation | null = null;
		let projectId: string | null = null;

		for (const [pid, invitations] of this.projectInvitations.entries()) {
			const invitation = invitations.find(i => i.token === token && i.status === 'pending');
			if (invitation) {
				foundInvitation = invitation;
				projectId = pid;
				break;
			}
		}

		if (!foundInvitation || !projectId) {
			throw new NotFoundError('Invalid or expired invitation');
		}

		// Check if invitation is expired
		if (foundInvitation.expiresAt < new Date()) {
			foundInvitation.status = 'expired';
			throw new BadRequestError('Invitation has expired');
		}

		// Get user
		const user = await this.userRepository.findOne({ where: { id: userId } });
		if (!user) {
			throw new NotFoundError('User not found');
		}

		// Check if email matches
		if (user.email !== foundInvitation.email) {
			throw new BadRequestError('Invitation email does not match user email');
		}

		// Check if user is already a member
		const existingMembers = this.projectMembers.get(projectId) || [];
		const existingMember = existingMembers.find(m => m.userId === userId);
		if (existingMember) {
			throw new BadRequestError('User is already a member of this project');
		}

		// Add user as member
		const member: ProjectMember = {
			id: this.generateId(),
			projectId,
			userId,
			role: foundInvitation.role,
			permissions: foundInvitation.permissions,
			joinedAt: new Date(),
			invitedBy: foundInvitation.invitedBy,
			status: 'active',
			user: {
				id: user.id,
				email: user.email,
				firstName: user.firstName,
				lastName: user.lastName,
				role: user.role,
			},
		};

		existingMembers.push(member);
		this.projectMembers.set(projectId, existingMembers);

		// Update invitation status
		foundInvitation.status = 'accepted';

		// Update project member count
		const project = this.projects.get(projectId);
		if (project) {
			project.memberCount = existingMembers.length;
			this.projects.set(projectId, project);
		}

		// Log activity
		await this.logActivity(projectId, userId, 'member:joined', 'member', undefined, {
			role: member.role,
		});

		this.logger.info(`User joined project: ${user.email}`, {
			projectId,
			userId,
			role: member.role,
		});

		return member;
	}

	/**
	 * Get project members
	 */
	async getProjectMembers(projectId: string, userId: string): Promise<ProjectMember[]> {
		// Check if user has access
		if (!await this.hasProjectAccess(projectId, userId, 'project:read')) {
			throw new ForbiddenError('Access denied to this project');
		}

		return this.projectMembers.get(projectId) || [];
	}

	/**
	 * Remove member from project
	 */
	async removeMember(projectId: string, userId: string, memberIdToRemove: string): Promise<void> {
		const project = this.projects.get(projectId);
		if (!project) {
			throw new NotFoundError('Project not found');
		}

		// Check permissions
		if (!await this.hasProjectAccess(projectId, userId, 'member:remove')) {
			throw new ForbiddenError('Insufficient permissions to remove members');
		}

		// Cannot remove project owner
		if (project.ownerId === memberIdToRemove) {
			throw new BadRequestError('Cannot remove project owner');
		}

		// Remove member
		const members = this.projectMembers.get(projectId) || [];
		const memberIndex = members.findIndex(m => m.userId === memberIdToRemove);

		if (memberIndex === -1) {
			throw new NotFoundError('Member not found in project');
		}

		const removedMember = members[memberIndex];
		members.splice(memberIndex, 1);
		this.projectMembers.set(projectId, members);

		// Update project member count
		project.memberCount = members.length;
		this.projects.set(projectId, project);

		// Log activity
		await this.logActivity(projectId, userId, 'member:removed', 'member', undefined, {
			removedUserId: memberIdToRemove,
			removedUserEmail: removedMember.user.email,
		});

		this.logger.info(`Member removed from project: ${removedMember.user.email}`, {
			projectId,
			userId,
			removedUserId: memberIdToRemove,
		});
	}

	/**
	 * Update member role/permissions
	 */
	async updateMember(
		projectId: string, 
		userId: string, 
		memberIdToUpdate: string, 
		updates: { role?: ProjectRole; permissions?: ProjectPermission[] }
	): Promise<ProjectMember> {
		// Check permissions
		if (!await this.hasProjectAccess(projectId, userId, 'member:manage')) {
			throw new ForbiddenError('Insufficient permissions to update members');
		}

		// Cannot update project owner role
		const project = this.projects.get(projectId);
		if (project && project.ownerId === memberIdToUpdate && updates.role && updates.role !== 'owner') {
			throw new BadRequestError('Cannot change project owner role');
		}

		// Update member
		const members = this.projectMembers.get(projectId) || [];
		const memberIndex = members.findIndex(m => m.userId === memberIdToUpdate);

		if (memberIndex === -1) {
			throw new NotFoundError('Member not found in project');
		}

		const member = members[memberIndex];
		
		if (updates.role) {
			member.role = updates.role;
		}

		if (updates.permissions) {
			member.permissions = updates.permissions;
		}

		members[memberIndex] = member;
		this.projectMembers.set(projectId, members);

		// Log activity
		await this.logActivity(projectId, userId, 'member:updated', 'member', undefined, {
			updatedUserId: memberIdToUpdate,
			updates,
		});

		this.logger.info(`Member updated in project: ${member.user.email}`, {
			projectId,
			userId,
			updatedUserId: memberIdToUpdate,
			updates,
		});

		return member;
	}

	/**
	 * Check if user has specific permission in project
	 */
	async hasProjectAccess(projectId: string, userId: string, permission: ProjectPermission): Promise<boolean> {
		const members = this.projectMembers.get(projectId) || [];
		const member = members.find(m => m.userId === userId && m.status === 'active');

		if (!member) {
			return false;
		}

		// Owners have all permissions
		if (member.role === 'owner') {
			return true;
		}

		// Check specific permission
		return member.permissions.includes(permission);
	}

	/**
	 * Get project activity log
	 */
	async getProjectActivity(projectId: string, userId: string, limit: number = 100, offset: number = 0): Promise<ProjectActivity[]> {
		// Check permissions
		if (!await this.hasProjectAccess(projectId, userId, 'project:read')) {
			throw new ForbiddenError('Access denied to this project');
		}

		const activities = this.projectActivities.get(projectId) || [];
		
		// Sort by date descending
		activities.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

		return activities.slice(offset, offset + limit);
	}

	// Private helper methods

	private generateId(): string {
		return randomBytes(16).toString('hex');
	}

	private generateInvitationToken(): string {
		return randomBytes(32).toString('hex');
	}

	private getAllPermissions(): ProjectPermission[] {
		return [
			'project:read', 'project:write', 'project:delete', 'project:manage',
			'workflow:create', 'workflow:read', 'workflow:write', 'workflow:delete', 'workflow:execute',
			'credential:create', 'credential:read', 'credential:write', 'credential:delete', 'credential:use',
			'member:invite', 'member:remove', 'member:manage',
			'settings:read', 'settings:write'
		];
	}

	private getDefaultPermissionsForRole(role: ProjectRole): ProjectPermission[] {
		switch (role) {
			case 'owner':
				return this.getAllPermissions();
			case 'admin':
				return [
					'project:read', 'project:write',
					'workflow:create', 'workflow:read', 'workflow:write', 'workflow:delete', 'workflow:execute',
					'credential:create', 'credential:read', 'credential:write', 'credential:delete', 'credential:use',
					'member:invite', 'member:remove',
					'settings:read'
				];
			case 'member':
				return [
					'project:read',
					'workflow:create', 'workflow:read', 'workflow:write', 'workflow:execute',
					'credential:read', 'credential:use'
				];
			case 'contributor':
				return [
					'project:read',
					'workflow:read', 'workflow:write', 'workflow:execute',
					'credential:read', 'credential:use'
				];
			case 'viewer':
				return [
					'project:read',
					'workflow:read',
					'credential:read'
				];
			default:
				return ['project:read'];
		}
	}

	private async getProjectWorkflowCount(projectId: string): Promise<number> {
		// In real implementation, this would query workflows table with project filter
		return 0;
	}

	private async getProjectCredentialCount(projectId: string): Promise<number> {
		// In real implementation, this would query credentials table with project filter
		return 0;
	}

	private async logActivity(
		projectId: string, 
		userId: string, 
		action: string, 
		resourceType?: 'workflow' | 'credential' | 'member', 
		resourceId?: string, 
		metadata: Record<string, any> = {}
	): Promise<void> {
		const activity: ProjectActivity = {
			id: this.generateId(),
			projectId,
			userId,
			action,
			resourceType,
			resourceId,
			metadata,
			createdAt: new Date(),
		};

		const activities = this.projectActivities.get(projectId) || [];
		activities.push(activity);
		this.projectActivities.set(projectId, activities);
	}
}