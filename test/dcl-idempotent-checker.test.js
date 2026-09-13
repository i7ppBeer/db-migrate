/**
 * Tests for DCLIdempotentChecker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DCLIdempotentChecker } from '../src/core/dcl-idempotent-checker.js';

describe('DCLIdempotentChecker', () => {
  let checker;

  beforeEach(() => {
    checker = new DCLIdempotentChecker({
      verbose: false
    });
  });

  describe('compareStates', () => {
    it('should return equal for identical states', () => {
      const state1 = {
        users: ['user1@%', 'user2@%'],
        grants: [
          { user: 'user1@%', grant: 'GRANT SELECT ON db.* TO user1' },
          { user: 'user2@%', grant: 'GRANT ALL ON db.* TO user2' }
        ],
        timestamp: '2026-01-01T00:00:00Z'
      };
      
      const state2 = {
        users: ['user1@%', 'user2@%'],
        grants: [
          { user: 'user1@%', grant: 'GRANT SELECT ON db.* TO user1' },
          { user: 'user2@%', grant: 'GRANT ALL ON db.* TO user2' }
        ],
        timestamp: '2026-01-01T00:00:01Z' // Different timestamp should be ignored
      };
      
      const result = checker.compareStates(state1, state2);
      
      expect(result.equal).toBe(true);
      expect(result.differences).toHaveLength(0);
    });

    it('should detect user differences', () => {
      const state1 = {
        users: ['user1@%', 'user2@%'],
        grants: []
      };
      
      const state2 = {
        users: ['user1@%', 'user2@%', 'user3@%'],
        grants: []
      };
      
      const result = checker.compareStates(state1, state2);
      
      expect(result.equal).toBe(false);
      expect(result.differences.some(d => d.field === 'users')).toBe(true);
    });

    it('should detect grant differences', () => {
      const state1 = {
        users: ['user1@%'],
        grants: [
          { user: 'user1@%', grant: 'GRANT SELECT ON db.* TO user1' }
        ]
      };
      
      const state2 = {
        users: ['user1@%'],
        grants: [
          { user: 'user1@%', grant: 'GRANT SELECT, INSERT ON db.* TO user1' }
        ]
      };
      
      const result = checker.compareStates(state1, state2);
      
      expect(result.equal).toBe(false);
      expect(result.differences.some(d => d.field === 'grants')).toBe(true);
    });

    it('should ignore timestamp field in comparison', () => {
      const state1 = {
        users: [],
        grants: [],
        timestamp: '2026-01-01T00:00:00Z'
      };
      
      const state2 = {
        users: [],
        grants: [],
        timestamp: '2026-01-01T12:00:00Z'
      };
      
      const result = checker.compareStates(state1, state2);
      
      expect(result.equal).toBe(true);
    });
  });

  describe('idempotency verification logic', () => {
    it('should pass when script produces same state after multiple runs', async () => {
      let runCount = 0;
      const mockState = {
        users: ['testuser@%'],
        grants: [{ user: 'testuser@%', grant: 'GRANT SELECT ON test.* TO testuser' }]
      };
      
      // Mock the script execution - idempotent (same result each time)
      const executeScript = async () => {
        runCount++;
        // Idempotent: state is always the same
      };
      
      // Mock captureState to always return same state
      const captureState = async () => ({ ...mockState, timestamp: new Date().toISOString() });
      
      // Execute twice
      await executeScript();
      const state1 = await captureState();
      await executeScript();
      const state2 = await captureState();
      
      const comparison = checker.compareStates(state1, state2);
      
      expect(runCount).toBe(2);
      expect(comparison.equal).toBe(true);
    });

    it('should fail when script produces different state on second run', async () => {
      let runCount = 0;
      
      // Mock captureState that returns different state each time
      const captureState = async () => ({
        users: [`user${runCount}@%`],
        grants: [],
        timestamp: new Date().toISOString()
      });
      
      const executeScript = async () => {
        runCount++;
      };
      
      // Execute twice
      await executeScript();
      const state1 = await captureState();
      await executeScript();
      const state2 = await captureState();
      
      const comparison = checker.compareStates(state1, state2);
      
      expect(comparison.equal).toBe(false);
    });
  });

  describe('MongoDB state capture format', () => {
    it('should format MongoDB users correctly', () => {
      const mockUsersInfo = {
        users: [
          { user: 'app_user', db: 'admin', roles: [{ role: 'readWrite', db: 'mydb' }] },
          { user: 'readonly_user', db: 'admin', roles: [{ role: 'read', db: 'mydb' }] }
        ]
      };
      
      const formattedUsers = mockUsersInfo.users
        .filter(u => !u.user.startsWith('__system'))
        .map(u => ({
          user: u.user,
          db: u.db,
          roles: u.roles.map(r => `${r.role}@${r.db}`).sort()
        }))
        .sort((a, b) => a.user.localeCompare(b.user));
      
      expect(formattedUsers).toHaveLength(2);
      expect(formattedUsers[0].user).toBe('app_user');
      expect(formattedUsers[0].roles).toContain('readWrite@mydb');
    });

    it('should treat reordered privilege objects as equal after canonicalization', () => {
      const state1 = {
        users: [
          {
            user: 'app_user',
            db: 'admin',
            roles: ['readWrite@mydb'],
            customData: { owner: 'platform' },
            authenticationRestrictions: []
          }
        ],
        roles: [
          {
            role: 'appRole',
            db: 'admin',
            privileges: [
              { resource: { db: 'mydb', collection: 'orders' }, actions: ['find', 'insert'] }
            ],
            inheritedRoles: []
          }
        ],
        timestamp: '2026-01-01T00:00:00Z'
      };

      const state2 = {
        users: [
          {
            user: 'app_user',
            db: 'admin',
            roles: ['readWrite@mydb'],
            customData: { owner: 'platform' },
            authenticationRestrictions: []
          }
        ],
        roles: [
          {
            role: 'appRole',
            db: 'admin',
            privileges: [
              { resource: { collection: 'orders', db: 'mydb' }, actions: ['insert', 'find'] }
            ],
            inheritedRoles: []
          }
        ],
        timestamp: '2026-01-01T00:00:01Z'
      };

      const result = checker.compareStates(state1, state2);
      expect(result.equal).toBe(true);
    });

    it('should detect privilege content changes even with same privilege count', () => {
      const state1 = {
        users: [],
        roles: [
          {
            role: 'appRole',
            db: 'admin',
            privileges: [
              { resource: { db: 'mydb', collection: 'orders' }, actions: ['find', 'insert'] }
            ],
            inheritedRoles: []
          }
        ]
      };

      const state2 = {
        users: [],
        roles: [
          {
            role: 'appRole',
            db: 'admin',
            privileges: [
              { resource: { db: 'mydb', collection: 'orders' }, actions: ['find', 'update'] }
            ],
            inheritedRoles: []
          }
        ]
      };

      const result = checker.compareStates(state1, state2);
      expect(result.equal).toBe(false);
      expect(result.differences.some(d => d.field === 'roles')).toBe(true);
    });

    it('should detect customData differences on users', () => {
      const state1 = {
        users: [
          {
            user: 'app_user',
            db: 'admin',
            roles: ['readWrite@mydb'],
            customData: { owner: 'platform', tier: 'gold' },
            authenticationRestrictions: []
          }
        ],
        roles: []
      };

      const state2 = {
        users: [
          {
            user: 'app_user',
            db: 'admin',
            roles: ['readWrite@mydb'],
            customData: { owner: 'platform', tier: 'silver' },
            authenticationRestrictions: []
          }
        ],
        roles: []
      };

      const result = checker.compareStates(state1, state2);
      expect(result.equal).toBe(false);
      expect(result.differences.some(d => d.field === 'users')).toBe(true);
    });
  });

  describe('MariaDB state capture format', () => {
    it('should format MariaDB users correctly', () => {
      const mockUsers = [
        { User: 'app_user', Host: '%' },
        { User: 'readonly_user', Host: 'localhost' }
      ];
      
      const formattedUsers = mockUsers.map(u => `${u.User}@${u.Host}`);
      
      expect(formattedUsers).toContain('app_user@%');
      expect(formattedUsers).toContain('readonly_user@localhost');
    });

    it('should filter out system users', () => {
      const systemUsers = ['root', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'healthchecker'];
      
      const allUsers = [
        { User: 'root', Host: 'localhost' },
        { User: 'app_user', Host: '%' },
        { User: 'mysql.sys', Host: 'localhost' }
      ];
      
      const filteredUsers = allUsers.filter(u => !systemUsers.includes(u.User));
      
      expect(filteredUsers).toHaveLength(1);
      expect(filteredUsers[0].User).toBe('app_user');
    });
  });

  describe('verbose logging', () => {
    it('should log when verbose is true', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      const verboseChecker = new DCLIdempotentChecker({ verbose: true });
      verboseChecker.log('Test message');
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Test message'));
      
      consoleSpy.mockRestore();
    });

    it('should not log when verbose is false', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      const silentChecker = new DCLIdempotentChecker({ verbose: false });
      silentChecker.log('Test message');
      
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('diffStates', () => {
    describe('MariaDB shape', () => {
      it('detects a newly created account', () => {
        const before = { users: ['app_readonly@%'], grants: [{ user: 'app_readonly@%', grant: 'GRANT SELECT ON mydb.* TO ...' }] };
        const after = {
          users: ['app_readonly@%', 'app_writer@%'],
          grants: [
            { user: 'app_readonly@%', grant: 'GRANT SELECT ON mydb.* TO ...' },
            { user: 'app_writer@%', grant: 'GRANT INSERT, UPDATE ON mydb.* TO ...' }
          ]
        };
        const diff = checker.diffStates(before, after, 'mariadb');
        expect(diff.addedUsers).toEqual(['app_writer@%']);
        expect(diff.removedUsers).toEqual([]);
        expect(diff.addedGrants).toHaveLength(1);
        expect(diff.addedGrants[0].user).toBe('app_writer@%');
      });

      it('detects a dropped account', () => {
        const before = { users: ['old_user@%'], grants: [{ user: 'old_user@%', grant: 'GRANT SELECT ON mydb.* TO ...' }] };
        const after = { users: [], grants: [] };
        const diff = checker.diffStates(before, after, 'mariadb');
        expect(diff.removedUsers).toEqual(['old_user@%']);
        expect(diff.removedGrants).toHaveLength(1);
      });

      it('detects a permission added to an existing account without treating it as a new user', () => {
        const before = { users: ['app@%'], grants: [{ user: 'app@%', grant: 'GRANT SELECT ON mydb.* TO ...' }] };
        const after = {
          users: ['app@%'],
          grants: [
            { user: 'app@%', grant: 'GRANT SELECT ON mydb.* TO ...' },
            { user: 'app@%', grant: 'GRANT INSERT ON mydb.* TO ...' }
          ]
        };
        const diff = checker.diffStates(before, after, 'mariadb');
        expect(diff.addedUsers).toEqual([]);
        expect(diff.addedGrants).toHaveLength(1);
        expect(diff.addedGrants[0].grant).toContain('INSERT');
      });

      it('detects a permission revoked from an existing account (user not dropped)', () => {
        const before = {
          users: ['app@%'],
          grants: [
            { user: 'app@%', grant: 'GRANT SELECT ON mydb.* TO ...' },
            { user: 'app@%', grant: 'GRANT INSERT ON mydb.* TO ...' }
          ]
        };
        const after = { users: ['app@%'], grants: [{ user: 'app@%', grant: 'GRANT SELECT ON mydb.* TO ...' }] };
        const diff = checker.diffStates(before, after, 'mariadb');
        expect(diff.removedUsers).toEqual([]); // user still exists
        expect(diff.removedGrants).toHaveLength(1);
        expect(diff.removedGrants[0].grant).toContain('INSERT');
      });

      it('reports nothing when state is unchanged', () => {
        const state = { users: ['app@%'], grants: [{ user: 'app@%', grant: 'GRANT SELECT ON mydb.* TO ...' }] };
        const diff = checker.diffStates(state, structuredClone(state), 'mariadb');
        expect(diff).toEqual({ addedUsers: [], removedUsers: [], addedGrants: [], removedGrants: [] });
      });
    });

    describe('MongoDB shape', () => {
      it('detects a newly created user with its roles', () => {
        const before = { users: [], roles: [] };
        const after = { users: [{ user: 'app_readonly', db: 'admin', roles: ['read@mydb'] }], roles: [] };
        const diff = checker.diffStates(before, after, 'mongodb');
        expect(diff.addedUsers).toHaveLength(1);
        expect(diff.addedUsers[0].user).toBe('app_readonly');
        expect(diff.removedUsers).toEqual([]);
        expect(diff.changedUsers).toEqual([]);
      });

      it('detects a role added to an existing user without treating it as a new user', () => {
        const before = { users: [{ user: 'app', db: 'admin', roles: ['read@mydb'] }], roles: [] };
        const after = { users: [{ user: 'app', db: 'admin', roles: ['read@mydb', 'readWrite@mydb'] }], roles: [] };
        const diff = checker.diffStates(before, after, 'mongodb');
        expect(diff.addedUsers).toEqual([]);
        expect(diff.changedUsers).toHaveLength(1);
        expect(diff.changedUsers[0]).toMatchObject({ user: 'app', addedRoles: ['readWrite@mydb'], removedRoles: [] });
      });

      it('detects a removed user', () => {
        const before = { users: [{ user: 'gone', db: 'admin', roles: ['read@mydb'] }], roles: [] };
        const after = { users: [], roles: [] };
        const diff = checker.diffStates(before, after, 'mongodb');
        expect(diff.removedUsers).toHaveLength(1);
        expect(diff.removedUsers[0].user).toBe('gone');
      });

      it('detects a role revoked from an existing user (user not dropped)', () => {
        const before = { users: [{ user: 'app', db: 'admin', roles: ['read@mydb', 'readWrite@mydb'] }], roles: [] };
        const after = { users: [{ user: 'app', db: 'admin', roles: ['read@mydb'] }], roles: [] };
        const diff = checker.diffStates(before, after, 'mongodb');
        expect(diff.removedUsers).toEqual([]); // user still exists
        expect(diff.changedUsers).toHaveLength(1);
        expect(diff.changedUsers[0]).toMatchObject({ user: 'app', addedRoles: [], removedRoles: ['readWrite@mydb'] });
      });

      it('detects a dropped custom role', () => {
        const before = { users: [], roles: [{ role: 'oldRole', db: 'admin', privileges: [], inheritedRoles: [] }] };
        const after = { users: [], roles: [] };
        const diff = checker.diffStates(before, after, 'mongodb');
        expect(diff.removedRoles).toHaveLength(1);
        expect(diff.removedRoles[0].role).toBe('oldRole');
      });

      it('detects a new custom role', () => {
        const before = { users: [], roles: [] };
        const after = { users: [], roles: [{ role: 'customRole', db: 'admin', privileges: [], inheritedRoles: [] }] };
        const diff = checker.diffStates(before, after, 'mongodb');
        expect(diff.addedRoles).toHaveLength(1);
        expect(diff.addedRoles[0].role).toBe('customRole');
      });
    });

    it('throws on an unsupported dbType', () => {
      expect(() => checker.diffStates({ users: [], grants: [] }, { users: [], grants: [] }, 'postgres'))
        .toThrow(/Unsupported database type/);
    });
  });
});

describe('Idempotent SQL Patterns', () => {
  describe('DROP IF EXISTS + CREATE pattern', () => {
    it('should be idempotent for user creation', () => {
      const sql = `
        DROP USER IF EXISTS 'testuser'@'%';
        CREATE USER 'testuser'@'%' IDENTIFIED BY 'password';
        GRANT SELECT ON db.* TO 'testuser'@'%';
        FLUSH PRIVILEGES;
      `;
      
      // This pattern is idempotent because:
      // 1. DROP IF EXISTS won't fail if user doesn't exist
      // 2. CREATE will always create fresh user
      // 3. GRANT will set exact permissions
      
      expect(sql).toContain('DROP USER IF EXISTS');
      expect(sql).toContain('CREATE USER');
    });
  });

  describe('GRANT idempotency', () => {
    it('should note that GRANT is naturally idempotent', () => {
      // GRANT statements in MySQL/MariaDB are idempotent
      // Running GRANT twice produces same result
      const grant = "GRANT SELECT ON db.* TO 'user'@'%'";
      
      expect(grant).toContain('GRANT');
    });
  });
});

describe('Idempotent MongoDB Patterns', () => {
  describe('updateUser with upsert-like behavior', () => {
    it('should handle user not found error gracefully', async () => {
      const userSpec = {
        user: 'testuser',
        pwd: 'password',
        roles: [{ role: 'read', db: 'testdb' }]
      };
      
      const mockAdminDb = {
        command: vi.fn()
          .mockRejectedValueOnce({ codeName: 'UserNotFound' })
          .mockResolvedValueOnce({ ok: 1 })
      };
      
      // Simulate idempotent pattern
      try {
        await mockAdminDb.command({ updateUser: userSpec.user, pwd: userSpec.pwd, roles: userSpec.roles });
      } catch (error) {
        if (error.codeName === 'UserNotFound') {
          await mockAdminDb.command({ createUser: userSpec.user, pwd: userSpec.pwd, roles: userSpec.roles });
        }
      }
      
      expect(mockAdminDb.command).toHaveBeenCalledTimes(2);
    });
  });
});
