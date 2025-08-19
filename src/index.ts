import { PrismaClient } from './generated/prisma/';
import { PrismaD1 } from '@prisma/adapter-d1';

export interface Env {
	DB: D1Database;
}

interface CreateGroupRequest {
	deviceToken: string;
	modelId: string;
	title?: string;
	description?: string;
	expirationHours?: number;
}

interface JoinGroupRequest {
	deviceToken: string;
	inviteCode: string;
}

// Helper function to generate short invite codes
function generateInviteCode(): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 8; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

// Helper function to ensure user exists
async function ensureUser(prisma: PrismaClient, deviceToken: string) {
	let user = await prisma.user.findUnique({
		where: { deviceToken }
	});

	if (!user) {
		user = await prisma.user.create({
			data: { deviceToken }
		});
	}

	return user;
}

// Helper function for JSON responses
function jsonResponse(data: any, status: number = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization'
		}
	});
}

// Helper function for error responses
function errorResponse(message: string, status: number = 400) {
	return jsonResponse({ error: message }, status);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const adapter = new PrismaD1(env.DB);
		const prisma = new PrismaClient({ adapter });

		const url = new URL(request.url);
		const method = request.method;
		const path = url.pathname;

		try {
			// CORS headers
			const corsHeaders = {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			};

			// Handle CORS preflight
			if (method === 'OPTIONS') {
				return new Response(null, { headers: corsHeaders });
			}

			// Route: POST /api/groups - Create group with invitation link
			if (method === 'POST' && path === '/api/groups') {
				const body: CreateGroupRequest = await request.json();
				
				if (!body.deviceToken || !body.modelId) {
					return errorResponse('deviceToken and modelId are required');
				}

				// Ensure user exists
				const user = await ensureUser(prisma, body.deviceToken);

				// Generate unique invite code
				let inviteCode: string;
				let isUnique = false;
				do {
					inviteCode = generateInviteCode();
					const existing = await prisma.group.findUnique({
						where: { inviteCode }
					});
					isUnique = !existing;
				} while (!isUnique);

				// Create group with expiration if specified
				const expiresAt = body.expirationHours 
					? new Date(Date.now() + body.expirationHours * 60 * 60 * 1000)
					: null;

				const group = await prisma.group.create({
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
				await prisma.groupMember.create({
					data: {
						userId: user.id,
						groupId: group.id
					}
				});

				return jsonResponse({
					groupId: group.id,
					inviteCode,
					inviteUrl: `https://coco.co/g/${inviteCode}`,
					modelId: body.modelId,
					title: body.title,
					description: body.description,
					expiresAt,
					memberCount: 1
				}, 201);
			}

			// Route: POST /api/groups/:code/join - Join group via invitation code
			if (method === 'POST' && path.match(/^\/api\/groups\/[^\/]+\/join$/)) {
				const inviteCode = path.split('/')[3];
				const body: JoinGroupRequest = await request.json();

				if (!body.deviceToken) {
					return errorResponse('deviceToken is required');
				}

				// Ensure user exists
				const user = await ensureUser(prisma, body.deviceToken);

				// Find group
				const group = await prisma.group.findUnique({
					where: { inviteCode },
					include: { 
						creator: { select: { id: true, name: true } },
						members: true
					}
				});

				if (!group) {
					return errorResponse('Group not found', 404);
				}

				// Check if group has expired
				if (group.expiresAt && group.expiresAt < new Date()) {
					return errorResponse('Group invitation has expired', 410);
				}

				// Check if user is already a member
				const existingMembership = await prisma.groupMember.findUnique({
					where: {
						userId_groupId: {
							userId: user.id,
							groupId: group.id
						}
					}
				});

				if (existingMembership) {
					return errorResponse('User is already a member of this group');
				}

				// Add user to group
				await prisma.groupMember.create({
					data: {
						userId: user.id,
						groupId: group.id
					}
				});

				return jsonResponse({
					success: true,
					groupId: group.id,
					modelId: group.modelId,
					title: group.title,
					description: group.description,
					memberCount: group.members.length + 1,
					message: 'Successfully joined the group'
				});
			}

			// Route: GET /api/groups/:code - Get group details
			if (method === 'GET' && path.startsWith('/api/groups/') && !path.endsWith('/join')) {
				const inviteCode = path.split('/')[3];

				const group = await prisma.group.findUnique({
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
					return errorResponse('Group not found', 404);
				}

				// Check if group has expired
				if (group.expiresAt && group.expiresAt < new Date()) {
					return errorResponse('Group invitation has expired', 410);
				}

				return jsonResponse({
					groupId: group.id,
					inviteCode: group.inviteCode,
					modelId: group.modelId,
					title: group.title,
					description: group.description,
					creator: group.creator,
					expiresAt: group.expiresAt,
					memberCount: group.members.length,
					members: group.members.map(m => m.user)
				});
			}

			// Route: GET /api/users/:deviceToken/groups - Get user's groups
			if (method === 'GET' && path.startsWith('/api/users/') && path.endsWith('/groups')) {
				const deviceToken = decodeURIComponent(path.split('/')[3]);

				const user = await prisma.user.findUnique({
					where: { deviceToken },
					include: {
						memberships: {
							include: {
								group: {
									include: {
										creator: { select: { id: true, name: true } },
										members: {
											include: {
												user: { select: { id: true, name: true } }
											}
										}
									}
								}
							}
						}
					}
				});

				if (!user) {
					return errorResponse('User not found', 404);
				}

				const groups = user.memberships.map(membership => ({
					groupId: membership.group.id,
					modelId: membership.group.modelId,
					inviteCode: membership.group.inviteCode,
					title: membership.group.title,
					description: membership.group.description,
					creator: membership.group.creator,
					joinedAt: membership.joinedAt,
					expiresAt: membership.group.expiresAt,
					memberCount: membership.group.members.length,
					members: membership.group.members.map((m: any) => m.user)
				}));

				return jsonResponse({ groups });
			}

			// Route: GET /api/users/:deviceToken/created-groups - Get user's created groups
			if (method === 'GET' && path.startsWith('/api/users/') && path.endsWith('/created-groups')) {
				const deviceToken = decodeURIComponent(path.split('/')[3]);

				const user = await prisma.user.findUnique({
					where: { deviceToken },
					include: {
						createdGroups: {
							include: {
								members: {
									include: {
										user: { select: { id: true, name: true } }
									}
								}
							}
						}
					}
				});

				if (!user) {
					return errorResponse('User not found', 404);
				}

				const groups = user.createdGroups.map(group => ({
					groupId: group.id,
					inviteCode: group.inviteCode,
					modelId: group.modelId,
					title: group.title,
					description: group.description,
					expiresAt: group.expiresAt,
					createdAt: group.createdAt,
					memberCount: group.members.length,
					members: group.members.map((m: any) => m.user)
				}));

				return jsonResponse({ groups });
			}

			// Default route - API info
			if (method === 'GET' && path === '/') {
				return jsonResponse({
					message: 'Coco-Pik Backend API',
					version: '1.0.0',
					description: 'Simple group wishlist API - like Airbnb wishlist but for 3D models',
					endpoints: {
						'POST /api/groups': 'Create a new group with invitation link',
						'GET /api/groups/:code': 'Get group details by invitation code',
						'POST /api/groups/:code/join': 'Join a group using invitation code',
						'GET /api/users/:deviceToken/groups': 'Get groups user has joined',
						'GET /api/users/:deviceToken/created-groups': 'Get groups user has created'
					}
				});
			}

			return errorResponse('Endpoint not found', 404);

		} catch (error) {
			console.error('API Error:', error);
			return errorResponse('Internal server error', 500);
		}
	},
} satisfies ExportedHandler<Env>;
