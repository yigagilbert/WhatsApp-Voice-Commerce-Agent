import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import type { Database, DashboardUser, OperatorRole } from '@vca/database';
import { ConflictError, NotFoundError, ValidationError } from '@vca/shared';
import type { AuditService } from './audit.service';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );

/** scrypt cost (OWASP minimum N=2^17 needs 128 MB; 2^15 keeps a login ~50 ms on a small VM). */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSWORD_LENGTH = 12;
/** Wrong passwords before an account is locked, and for how long. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Used when the username doesn't exist, so a miss takes as long as a wrong password. */
let decoyHash: Promise<string> | null = null;

export function checkPasswordPolicy(password: string, username?: string): void {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new ValidationError(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (password.length > 200) throw new ValidationError('That password is too long.');
  if (username && password.toLowerCase().includes(username.toLowerCase()))
    throw new ValidationError("The password can't contain the username.");
}

export const normalizeUsername = (username: string) => username.trim().toLowerCase();

const USERNAME = /^[a-z0-9][a-z0-9._@-]{1,63}$/;

export type LoginResult =
  | { status: 'ok'; user: DashboardUser }
  | { status: 'invalid' }
  | { status: 'locked'; until: Date }
  /** No dashboard account exists yet: only the bootstrap login can be used. */
  | { status: 'no_users' };

/** Public view of an account (never the hash). */
export type DashboardUserView = Omit<DashboardUser, 'passwordHash'>;
const view = ({ passwordHash: _hash, ...user }: DashboardUser): DashboardUserView => user;

/**
 * Individual dashboard accounts: scrypt-hashed passwords, per-account lockout after repeated wrong
 * passwords (independent of the client IP, which a caller can't be trusted to report), and a
 * session version that revokes every existing session on password change or deactivation.
 */
export class DashboardUserService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  count() {
    return this.db.dashboardUser.count();
  }

  async list(merchantId: string): Promise<DashboardUserView[]> {
    const users = await this.db.dashboardUser.findMany({
      where: { merchantId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    return users.map(view);
  }

  async login(username: string, password: string, now = new Date()): Promise<LoginResult> {
    const user = await this.db.dashboardUser.findUnique({
      where: { username: normalizeUsername(username) },
    });
    if (!user) {
      decoyHash ??= hashPassword(randomBytes(16).toString('hex'));
      await verifyPassword(password, await decoyHash);
      return (await this.count()) === 0 ? { status: 'no_users' } : { status: 'invalid' };
    }
    if (user.lockedUntil && user.lockedUntil > now)
      return { status: 'locked', until: user.lockedUntil };
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok || !user.active) {
      const failed = user.failedLogins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.db.dashboardUser.update({
        where: { id: user.id },
        data: {
          failedLogins: lock ? 0 : failed,
          ...(lock ? { lockedUntil: new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) } : {}),
        },
      });
      await this.audit.record({
        merchantId: user.merchantId,
        actor: 'MERCHANT',
        type: lock ? 'auth.account_locked' : 'auth.login_failed',
        entityType: 'dashboard_user',
        entityId: user.id,
        data: { username: user.username, ...(user.active ? {} : { inactive: true }) },
      });
      return { status: 'invalid' };
    }
    const updated = await this.db.dashboardUser.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now },
    });
    await this.audit.record({
      merchantId: user.merchantId,
      actor: 'MERCHANT',
      type: 'auth.login',
      entityType: 'dashboard_user',
      entityId: user.id,
      data: { username: user.username },
    });
    return { status: 'ok', user: updated };
  }

  /** The account behind a session, if the session is still valid (active, same version). */
  async session(userId: string, version: number): Promise<DashboardUser | null> {
    const user = await this.db.dashboardUser.findUnique({ where: { id: userId } });
    return user && user.active && user.sessionVersion === version ? user : null;
  }

  async create(
    merchantId: string,
    input: { username: string; name: string; role: OperatorRole; password: string },
    by: string,
  ): Promise<DashboardUserView> {
    const username = normalizeUsername(input.username);
    if (!USERNAME.test(username))
      throw new ValidationError(
        'Usernames are 2–64 characters: letters, digits, dot, dash, underscore or @.',
      );
    const name = input.name.trim();
    if (!name || name.length > 120) throw new ValidationError('Please enter a name.');
    checkPasswordPolicy(input.password, username);
    if (await this.db.dashboardUser.findUnique({ where: { username } }))
      throw new ConflictError('That username is already taken.');
    const user = await this.db.dashboardUser.create({
      data: {
        merchantId,
        username,
        name,
        role: input.role,
        passwordHash: await hashPassword(input.password),
      },
    });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'dashboard_user.created',
      entityType: 'dashboard_user',
      entityId: user.id,
      data: { username, role: input.role, by },
    });
    return view(user);
  }

  /**
   * Owner changes to an account. A new password, deactivation or a role change signs the person
   * out everywhere. The last active owner can't be demoted or deactivated.
   */
  async update(
    merchantId: string,
    id: string,
    input: { name?: string; role?: OperatorRole; active?: boolean; password?: string },
    by: string,
  ): Promise<DashboardUserView> {
    const user = await this.db.dashboardUser.findFirst({ where: { id, merchantId } });
    if (!user) throw new NotFoundError('Dashboard user', id);
    const losesOwner =
      user.role === 'OWNER' &&
      user.active &&
      ((input.role !== undefined && input.role !== 'OWNER') || input.active === false);
    if (losesOwner) {
      const owners = await this.db.dashboardUser.count({
        where: { merchantId, role: 'OWNER', active: true },
      });
      if (owners <= 1)
        throw new ConflictError('Keep at least one active owner: add another owner first.');
    }
    if (input.password !== undefined) checkPasswordPolicy(input.password, user.username);
    const revoke =
      input.password !== undefined ||
      input.active === false ||
      (input.role !== undefined && input.role !== user.role);
    const updated = await this.db.dashboardUser.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim().slice(0, 120) } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.password !== undefined
          ? {
              passwordHash: await hashPassword(input.password),
              passwordChangedAt: new Date(),
              failedLogins: 0,
              lockedUntil: null,
            }
          : {}),
        ...(revoke ? { sessionVersion: { increment: 1 } } : {}),
      },
    });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'dashboard_user.updated',
      entityType: 'dashboard_user',
      entityId: id,
      data: {
        username: user.username,
        by,
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.password !== undefined ? { passwordReset: true } : {}),
      },
    });
    return view(updated);
  }

  /** A signed-in person changes their own password (and is signed out of other sessions). */
  async changePassword(id: string, current: string, next: string): Promise<DashboardUser> {
    const user = await this.db.dashboardUser.findUnique({ where: { id } });
    if (!user || !user.active) throw new NotFoundError('Dashboard user', id);
    if (!(await verifyPassword(current, user.passwordHash)))
      throw new ValidationError('Your current password is not correct.');
    checkPasswordPolicy(next, user.username);
    const updated = await this.db.dashboardUser.update({
      where: { id },
      data: {
        passwordHash: await hashPassword(next),
        passwordChangedAt: new Date(),
        sessionVersion: { increment: 1 },
      },
    });
    await this.audit.record({
      merchantId: user.merchantId,
      actor: 'MERCHANT',
      type: 'dashboard_user.password_changed',
      entityType: 'dashboard_user',
      entityId: id,
      data: { username: user.username },
    });
    return updated;
  }
}
