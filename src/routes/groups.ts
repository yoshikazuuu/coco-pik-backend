import { OpenAPIRoute, OpenAPIRouteSchema } from '@cloudflare/itty-router-openapi';
import { PrismaClient } from '../generated/prisma/';
import { PrismaD1 } from '@prisma/adapter-d1';
import {
    CreateGroupRequest,
    JoinGroupRequest,
    CreateGroupResponse,
    JoinGroupResponse,
    GroupDetailsResponse,
    AppContext,
    Env
} from '../types';
import {
    ensureUser,
    generateInviteCode,
    createJsonResponse,
    createErrorResponse,
    isGroupExpired,
    createErrorPage,
    createGroupLandingPage
} from '../utils/helpers';

export class CreateGroup extends OpenAPIRoute {
    static schema: OpenAPIRouteSchema = {
        tags: ['Groups'],
        summary: 'Create a new group',
        description: 'Create a new group with invitation link',

        responses: {
            '201': {
                description: 'Group created successfully',
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                groupId: { type: 'string' },
                                inviteCode: { type: 'string' },
                                inviteUrl: { type: 'string' },
                                modelId: { type: 'string' },
                                title: { type: 'string', nullable: true },
                                description: { type: 'string', nullable: true },
                                expiresAt: { type: 'string', format: 'date-time', nullable: true },
                                memberCount: { type: 'number' }
                            }
                        }
                    }
                }
            },
            '400': {
                description: 'Bad request',
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                error: { type: 'string' }
                            }
                        }
                    }
                }
            }
        }
    };

    async handle(request: Request, env: Env, ctx: ExecutionContext) {
        const adapter = new PrismaD1(env.DB);
        const prisma = new PrismaClient({ adapter });
        const context: AppContext = { prisma, env };
        try {
            const body: CreateGroupRequest = await request.json();

            if (!body.deviceToken || !body.modelId) {
                return createErrorResponse('deviceToken and modelId are required');
            }

            // Ensure user exists
            const user = await ensureUser(context.prisma, body.deviceToken);

            // Generate unique invite code
            let inviteCode: string;
            let isUnique = false;
            do {
                inviteCode = generateInviteCode();
                const existing = await context.prisma.group.findUnique({
                    where: { inviteCode }
                });
                isUnique = !existing;
            } while (!isUnique);

            // Create group with expiration if specified
            const expiresAt = body.expirationHours
                ? new Date(Date.now() + body.expirationHours * 60 * 60 * 1000)
                : null;

            const group = await context.prisma.group.create({
                data: {
                    inviteCode,
                    modelId: body.modelId,
                    creatorId: user.id,
                    title: body.title,
                    description: body.description,
                    expiresAt
                }
            });

            // Add creator as first member
            await context.prisma.groupMember.create({
                data: {
                    userId: user.id,
                    groupId: group.id
                }
            });

            const url = new URL(request.url);
            const response: CreateGroupResponse = {
                groupId: group.id,
                inviteCode,
                inviteUrl: `http://${url.host}/g/${inviteCode}`,
                modelId: body.modelId,
                title: body.title,
                description: body.description,
                expiresAt,
                memberCount: 1
            };

            return createJsonResponse(response, 201);
        } catch (error) {
            console.error('Error creating group:', error);
            return createErrorResponse('Internal server error', 500);
        }
    }
}

export class JoinGroup extends OpenAPIRoute {
    static schema: OpenAPIRouteSchema = {
        tags: ['Groups'],
        summary: 'Join a group',
        description: 'Join a group using invitation code',


        responses: {
            '200': {
                description: 'Successfully joined group',
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                success: { type: 'boolean' },
                                groupId: { type: 'string' },
                                modelId: { type: 'string' },
                                title: { type: 'string' },
                                description: { type: 'string' },
                                memberCount: { type: 'number' },
                                message: { type: 'string' }
                            }
                        }
                    }
                }
            }
        }
    };

    async handle(request: Request, env: Env, ctx: ExecutionContext, data: any) {
        console.log('JoinGroup data:', data);
        const code = data?.code || data?.params?.code;
        console.log('Extracted code:', code);

        const adapter = new PrismaD1(env.DB);
        const prisma = new PrismaClient({ adapter });
        const context: AppContext = { prisma, env };
        try {
            const body: JoinGroupRequest = await request.json();

            if (!body.deviceToken) {
                return createErrorResponse('deviceToken is required');
            }

            // Ensure user exists
            const user = await ensureUser(context.prisma, body.deviceToken);

            // Find group
            const group = await context.prisma.group.findUnique({
                where: { inviteCode: code },
                include: {
                    creator: { select: { id: true, name: true } },
                    members: true
                }
            });

            if (!group) {
                return createErrorResponse('Group not found', 404);
            }

            // Check if group has expired
            if (isGroupExpired(group.expiresAt)) {
                return createErrorResponse('Group invitation has expired', 410);
            }

            // Check if user is already a member
            const existingMembership = await context.prisma.groupMember.findUnique({
                where: {
                    userId_groupId: {
                        userId: user.id,
                        groupId: group.id
                    }
                }
            });

            if (existingMembership) {
                return createErrorResponse('User is already a member of this group');
            }

            // Add user to group
            await context.prisma.groupMember.create({
                data: {
                    userId: user.id,
                    groupId: group.id
                }
            });

            const response: JoinGroupResponse = {
                success: true,
                groupId: group.id,
                modelId: group.modelId,
                title: group.title,
                description: group.description,
                memberCount: group.members.length + 1,
                message: 'Successfully joined the group'
            };

            return createJsonResponse(response);
        } catch (error) {
            console.error('Error joining group:', error);
            return createErrorResponse('Internal server error', 500);
        }
    }
}

export class GetGroupDetails extends OpenAPIRoute {
    static schema: OpenAPIRouteSchema = {
        tags: ['Groups'],
        summary: 'Get group details',
        description: 'Get group details by invitation code',

        responses: {
            '200': {
                description: 'Group details',
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                groupId: { type: 'string' },
                                inviteCode: { type: 'string' },
                                modelId: { type: 'string' },
                                title: { type: 'string' },
                                description: { type: 'string' },
                                creator: {
                                    type: 'object',
                                    properties: {
                                        id: { type: 'string' },
                                        name: { type: 'string' }
                                    }
                                },
                                expiresAt: { type: 'string', format: 'date-time', nullable: true },
                                memberCount: { type: 'number' },
                                members: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'string' },
                                            name: { type: 'string' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    async handle(request: Request, env: Env, ctx: ExecutionContext, data: any) {
        console.log('GetGroupDetails data:', data);
        const code = data?.code || data?.params?.code;
        console.log('Extracted code:', code);

        const adapter = new PrismaD1(env.DB);
        const prisma = new PrismaClient({ adapter });
        const context: AppContext = { prisma, env };
        try {
            const group = await context.prisma.group.findUnique({
                where: { inviteCode: code },
                include: {
                    creator: { select: { id: true, name: true } },
                    members: {
                        include: {
                            user: { select: { id: true, name: true } }
                        }
                    }
                }
            });

            if (!group) {
                return createErrorResponse('Group not found', 404);
            }

            // Check if group has expired
            if (isGroupExpired(group.expiresAt)) {
                return createErrorResponse('Group invitation has expired', 410);
            }

            const response: GroupDetailsResponse = {
                groupId: group.id,
                inviteCode: group.inviteCode,
                modelId: group.modelId,
                title: group.title,
                description: group.description,
                creator: group.creator,
                expiresAt: group.expiresAt,
                memberCount: group.members.length,
                members: group.members.map(m => m.user)
            };

            return createJsonResponse(response);
        } catch (error) {
            console.error('Error getting group details:', error);
            return createErrorResponse('Internal server error', 500);
        }
    }
}

// Non-API route for group landing page
export async function handleGroupLandingPage(request: Request, env: Env, inviteCode: string) {
    const adapter = new PrismaD1(env.DB);
    const prisma = new PrismaClient({ adapter });
    const context: AppContext = { prisma, env };
    try {
        const group = await context.prisma.group.findUnique({
            where: { inviteCode },
            include: {
                creator: { select: { id: true, name: true } },
                members: {
                    include: {
                        user: { select: { id: true, name: true } }
                    }
                }
            }
        });

        if (!group) {
            return createErrorPage('Group Not Found', 'The invite link you followed is invalid or has expired.');
        }

        // Check if group has expired
        if (isGroupExpired(group.expiresAt)) {
            return createErrorPage('Invitation Expired', 'This group invitation has expired.');
        }

        const url = new URL(request.url);
        return createGroupLandingPage(group, inviteCode, url.host);
    } catch (error) {
        console.error('Error handling group landing page:', error);
        return createErrorPage('Error', 'An error occurred while loading the group.');
    }
}
