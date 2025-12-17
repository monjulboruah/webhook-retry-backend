// src/api/middleware.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key';

// Extend Fastify's Request type to include 'user'
declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      email: string;
    };
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return reply.status(401).send({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1]; // Remove "Bearer "
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    
    // Attach user info to the request object
    request.user = decoded;
  } catch (err) {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}