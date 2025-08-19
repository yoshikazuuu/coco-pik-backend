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
		const host = url.host;

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
					inviteUrl: `http://${host}/g/${inviteCode}`,
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

			// Route: GET /g/:code - Redirect to group or show simple landing page
			if (method === 'GET' && path.startsWith('/g/')) {
				const inviteCode = path.split('/')[2];

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
					return new Response(`
						<!DOCTYPE html>
						<html>
						<head>
							<title>Coco-Pik - Group Not Found</title>
							<meta name="viewport" content="width=device-width, initial-scale=1">
							<style>
								body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
								.container { max-width: 500px; margin: 0 auto; }
								.error { color: #e74c3c; }
							</style>
						</head>
						<body>
							<div class="container">
								<h1>Group Not Found</h1>
								<p class="error">The invite link you followed is invalid or has expired.</p>
							</div>
						</body>
						</html>
					`, {
						headers: { 'Content-Type': 'text/html' }
					});
				}

				// Check if group has expired
				if (group.expiresAt && group.expiresAt < new Date()) {
					return new Response(`
						<!DOCTYPE html>
						<html>
						<head>
							<title>Coco-Pik - Invitation Expired</title>
							<meta name="viewport" content="width=device-width, initial-scale=1">
							<style>
								body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
								.container { max-width: 500px; margin: 0 auto; }
								.error { color: #e74c3c; }
							</style>
						</head>
						<body>
							<div class="container">
								<h1>Invitation Expired</h1>
								<p class="error">This group invitation has expired.</p>
							</div>
						</body>
						</html>
					`, {
						headers: { 'Content-Type': 'text/html' }
					});
				}

				// Show group landing page
				return new Response(`
					<!DOCTYPE html>
					<html>
					<head>
						<title>Coco-Pik - ${group.title || 'Join Group'}</title>
						<meta name="viewport" content="width=device-width, initial-scale=1">
						<style>
							body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
							.group-card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; }
							.title { color: #2c3e50; margin-bottom: 10px; }
							.description { color: #7f8c8d; margin-bottom: 20px; }
							.members { background: #f8f9fa; padding: 15px; border-radius: 5px; }
							.member { display: inline-block; background: #3498db; color: white; padding: 5px 10px; margin: 2px; border-radius: 3px; }
							.join-button { background: #27ae60; color: white; padding: 12px 24px; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; }
							.api-info { background: #ecf0f1; padding: 15px; border-radius: 5px; margin-top: 20px; }
							.api-info code { background: #34495e; color: white; padding: 2px 5px; border-radius: 3px; }
						</style>
					</head>
					<body>
						<div class="group-card">
							<h1 class="title">${group.title || 'Join Group'}</h1>
							${group.description ? `<p class="description">${group.description}</p>` : ''}
							<p><strong>Model ID:</strong> ${group.modelId}</p>
							<p><strong>Created by:</strong> ${group.creator.name || 'Anonymous'}</p>
							
							<div class="members">
								<h3>Members (${group.members.length})</h3>
								${group.members.map(m => `<span class="member">${m.user.name || 'Anonymous'}</span>`).join('')}
							</div>
							
							<div class="api-info">
								<h3>API Integration</h3>
								<p>To join this group programmatically, POST to:</p>
								<code>POST https://${host}/api/groups/${inviteCode}/join</code>
								<p>With body: <code>{"deviceToken": "your-device-token"}</code></p>
								
								<p>To get group details:</p>
								<code>GET https://${host}/api/groups/${inviteCode}</code>
							</div>
						</div>
					</body>
					</html>
				`, {
					headers: { 'Content-Type': 'text/html' }
				});
			}
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
					deployedAt: `https://${host}`,
					endpoints: {
						'POST /api/groups': 'Create a new group with invitation link',
						'GET /api/groups/:code': 'Get group details by invitation code',
						'POST /api/groups/:code/join': 'Join a group using invitation code',
						'GET /api/users/:deviceToken/groups': 'Get groups user has joined',
						'GET /api/users/:deviceToken/created-groups': 'Get groups user has created',
						'GET /g/:code': 'View group invitation page (HTML)'
					},
					exampleFlow: {
						'1. Create group': `POST https://${host}/api/groups`,
						'2. Share invite URL': `https://${host}/g/{inviteCode}`,
						'3. Join group': `POST https://${host}/api/groups/{inviteCode}/join`
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
