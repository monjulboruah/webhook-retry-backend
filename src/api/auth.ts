// src/api/auth.ts
import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key';

export async function authRoutes(fastify: FastifyInstance) {
  
  // POST /auth/signup
  fastify.post('/auth/signup', async (req, reply) => {
    const { email, password } = req.body as any;

    // 1. Check if user exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.status(400).send({ error: 'User already exists' });

    // 2. Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Create User
    const user = await prisma.user.create({
      data: { email, password: hashedPassword }
    });

    // 4. Generate Token
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET);

    return { token, user: { id: user.id, email: user.email } };
  });

  // POST /auth/login
  fastify.post('/auth/login', async (req, reply) => {
    const { email, password } = req.body as any;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.status(400).send({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return reply.status(400).send({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET);

    return { token, user: { id: user.id, email: user.email } };
  });
}