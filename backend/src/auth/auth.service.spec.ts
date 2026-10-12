import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

const mockUser = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  passwordHash: '',
};

function makeService(prismaOverrides: Partial<{ user: any }> = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      ...prismaOverrides.user,
    },
  } as unknown as PrismaService;

  const jwt   = { sign: jest.fn().mockReturnValue('signed-token') } as unknown as JwtService;
  const alert = { send: jest.fn().mockResolvedValue(undefined) } as any;

  return { svc: new AuthService(prisma, jwt, alert), prisma, jwt };
}

describe('AuthService', () => {
  beforeAll(async () => {
    mockUser.passwordHash = await bcrypt.hash('Password1!', 12);
  });

  describe('register', () => {
    it('creates user and returns token when email is new', async () => {
      const { svc, prisma } = makeService({
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(mockUser),
        },
      });

      const result = await svc.register({ email: mockUser.email, password: 'Password1!' });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: mockUser.email } });
      expect(result.accessToken).toBe('signed-token');
      expect(result.email).toBe(mockUser.email);
    });

    it('throws ConflictException when email already exists', async () => {
      const { svc } = makeService({
        user: {
          findUnique: jest.fn().mockResolvedValue(mockUser),
          create: jest.fn(),
        },
      });

      await expect(svc.register({ email: mockUser.email, password: 'x' }))
        .rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('login', () => {
    it('returns token on valid credentials', async () => {
      const { svc } = makeService({
        user: {
          findUnique: jest.fn().mockResolvedValue(mockUser),
        },
      });

      const result = await svc.login({ email: mockUser.email, password: 'Password1!' });
      expect(result.accessToken).toBe('signed-token');
    });

    it('throws UnauthorizedException when user not found', async () => {
      const { svc } = makeService({
        user: { findUnique: jest.fn().mockResolvedValue(null) },
      });

      await expect(svc.login({ email: 'no@one.com', password: 'x' }))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException on wrong password', async () => {
      const { svc } = makeService({
        user: { findUnique: jest.fn().mockResolvedValue(mockUser) },
      });

      await expect(svc.login({ email: mockUser.email, password: 'wrong' }))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
