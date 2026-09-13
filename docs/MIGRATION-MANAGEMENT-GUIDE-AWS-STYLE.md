# Future Press Release (Internal Press Release)

> *This is an internal document in the AWS Working Backwards style, used to clarify product vision and customer value before development begins.*

---

## db-migrate Officially Launches: Ending "Database Change Anxiety"

**Development teams no longer fear deploying database changes on Fridays**

---

**Q2 2026** — Today, we are releasing db-migrate, a migration management system built specifically to solve "database change anxiety."

### The Problem We're Solving

After in-depth interviews with more than 50 development teams, we uncovered a startling fact:

> **"Our down migration has never been tested."**

This isn't an isolated case — it's the industry norm. Here are the real pain points we collected:

---

#### 😰 Pain Point 1: Rollback scripts are never tested

*"We write down migrations just to pass code review — nobody actually runs them. It's only on the day something breaks that we discover they don't even work."*

**Data**: 90% of teams have never tested their rollback scripts before deployment.

**Consequence**: When production issues require a rollback, manual fixes take an average of 2-4 hours, instead of the expected 5-minute automated rollback.

---

#### 😱 Pain Point 2: Dangerous operations slip through unnoticed

*"A junior engineer accidentally wrote DROP DATABASE in a migration, and code review missed it and merged it anyway."*

**Data**: 65% of database-related production incidents stem from dangerous operations that review failed to catch.

**Consequence**: Permanent data loss, extended service outages, and damaged customer trust.

---

#### 😤 Pain Point 3: Problems are only discovered after the migration runs

*"The migration reported success, but all the business logic broke — the column was added, but the data wasn't populated correctly."*

**Data**: 40% of migration problems aren't discovered until hours or even days after execution.

**Consequence**: By the time it's discovered, a simple rollback is no longer possible, and a compensating script is needed to fix the data.

---

#### 😵 Pain Point 4: Chaotic permission management

*"Developers can change database permissions directly, and someone accidentally committed the root password into a migration."*

**Data**: 25% of security incidents are related to database permission changes.

**Consequence**: Sensitive information leaks, permission abuse, and failed compliance audits.

---

### Our Solution

db-migrate provides a corresponding mechanism for each of the pain points above:

| Pain Point | Solution | Effect |
|------|----------|------|
| Rollback scripts never tested | **Mandatory three-stage Up-Down-Up testing** | Rollback success rate: 30% → 95% |
| Dangerous operations slip through | **Automatic dangerous-operation blocking + smart pairing detection** | 100% of dangerous operations blocked or flagged |
| Problems only found after execution | **Sanity check + automatic rollback** | Detection time: hours → seconds |
| Chaotic permission management | **Mandatory DDL/DCL separation** | Permission changes require independent review |

#### Full Solution Comparison Table

| Pain Point | Solution |
|------|----------|
| Table locking / downtime | Dangerous statement detection (forbids non-CONCURRENTLY indexes) |
| Data loss | Forbids DROP DATABASE / TRUNCATE |
| No rollback possible | Mandatory three-stage Up-Down-Up testing |
| Environment inconsistency | Versioning + changelog tracking |
| Migration conflicts | Timestamped filenames + automatic CI detection |
| Unclear ownership | DDL / DCL directory separation |
| No review process | PR review + --allow-dangerous flag |
| Manual execution | Automated deployment via K8s Job |
| No dry-run | --dry-run mode to preview changes |

---

### Availability

db-migrate is now open source (MIT license), supports MongoDB and MariaDB/MySQL, and ships a CLI, a Docker image, and a Kubernetes Helm chart.

---

# FAQ

## Customer FAQ

### Q1: Why Can't Existing Migration Tools Solve These Problems?

**A:** Existing tools (migrate-mongo, Flyway, Liquibase) focus on "version control" — recording which migrations have run. But that's not the real problem.

The real problems are:
- **No mechanism to enforce rollback testing** → the tool won't stop you from deploying an untested rollback script
- **No mechanism to block dangerous operations** → DROP DATABASE can sail right through
- **No mechanism to validate the execution result** → "successful" execution doesn't mean the result is "correct"

db-migrate isn't trying to replace version control — it adds a "safety layer" on top of it.

---

### Q2: What Is "Mandatory Three-Stage Up-Down-Up Testing"? Why Does It Matter?

**A:** This is db-migrate's core mechanism:

```
UP (upgrade) → DOWN (rollback) → UP (upgrade again)
```

**Why does this matter?**

Imagine a scenario: you write a migration that adds a column, then write a down migration that drops it. Looks perfect, right?

But what if:
- the down migration has a syntax error?
- the down migration drops the wrong column?
- after the down migration runs, the up migration no longer works (because of leftover data)?

You only discover these problems by **actually running it once**. Up-Down-Up ensures:
1. UP can execute ✓
2. DOWN can roll back ✓
3. UP still works after rolling back ✓ (proving the rollback was clean)

---

### Q3: What Is "Automatic Dangerous-Operation Blocking"? Can It Misfire?

**A:** The system automatically detects the following dangerous operations:

| Type | Dangerous Operation |
|------|------|
| Data deletion | `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `db.collection.drop()` |
| Permission changes | `GRANT`, `REVOKE`, `CREATE USER`, `ALTER USER` |
| Structural changes | `DROP COLUMN` (can cause data loss) |

**Can it misfire?**

Yes, and that's intentional. We'd rather have false positives than miss a real one.

But we provide a "smart pairing" mechanism to reduce false positives:

**MongoDB example:**
```javascript
// This case is allowed through automatically
export const up = async (db) => {
  await db.createCollection('temp_orders'); // CREATE
};
export const down = async (db) => {
  await db.collection('temp_orders').drop(); // DROP ← allowed automatically, since it's paired
};
```

**MariaDB/MySQL example:**
```sql
-- +migrate Up
CREATE TABLE temp_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_date DATETIME NOT NULL
);

-- +migrate Down
DROP TABLE temp_orders;  -- ✅ Allowed automatically, since it's paired with a CREATE
```

If a dangerous operation is genuinely required, use a `-- migrate-ignore: drop` comment and explain the reason.

---

### Q4: What Is a "Sanity Check"? How Is It Different From Regular Testing?

**A:** A sanity check is **automatic post-execution validation** that ensures "executed successfully" actually means "the result is correct."

**For example**:

You want to add a `phone` column to all users, defaulting to an empty string:

```javascript
export const up = async (db) => {
  await db.collection('users').updateMany({}, { $set: { phone: '' } });
};
```

After running it, MongoDB returns `{ acknowledged: true }`. Success?

Not necessarily. It's possible that:
- some documents weren't updated due to a filter condition issue
- documents were written by another process during the update

**The sanity check validates the result**:

**MongoDB example:**
```javascript
export const postCheck = async ({ db }) => {
  const missing = await db.collection('users').countDocuments({ 
    phone: { $exists: false } 
  });
  
  if (missing > 0) {
    return { 
      success: false, 
      error: `${missing} records are missing the phone field` 
    };
  }
  return { success: true };
};
```

**MariaDB/MySQL example:**
```sql
-- +migrate Up
ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT '';
UPDATE users SET phone = '' WHERE phone IS NULL;

-- +sanity PostCheck
-- Validate that every user has a non-NULL phone field
SELECT 
  CASE 
    WHEN COUNT(*) = 0 THEN 1
    ELSE 0
  END AS success,
  CASE 
    WHEN COUNT(*) > 0 THEN CONCAT(COUNT(*), ' records have a NULL phone field')
    ELSE NULL
  END AS error
FROM users WHERE phone IS NULL;
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE users DROP COLUMN phone;
```

If `postCheck` fails, the system will **automatically run down() to roll back**.

---

### Q5: Won't Automatic Rollback Cause Bigger Problems?

**A:** This is a common concern. Let me explain why automatic rollback is safe:

**Prerequisites**:
- Your migration has already passed Up-Down-Up testing
- This means the down migration is **verified to work**

**The logic behind automatic rollback**:
1. `postCheck` fails → the problem is detected
2. `down()` runs → returns to the pre-execution state
3. The problem is stopped before it causes greater impact

**If you're still not comfortable**:
```bash
# Disable automatic rollback and only show a warning
node src/cli.js up --sanity-check --no-auto-rollback
```

---

### Q6: My Team Is Busy and Doesn't Have Time to Adopt a New Tool. How Long Will It Take?

**A:** We designed db-migrate for **incremental adoption**, starting from 5 minutes:

| Stage | Time | What to Do | What You Get |
|------|------|--------|----------|
| 1 | 5 minutes | Run `validate` against your existing migrations | An immediate report of potential risks |
| 2 | 30 minutes | Add `validate` to CI | Automatic blocking of dangerous operations |
| 3 | At your own pace | Enable Up-Down-Up testing | Confidence that rollback scripts work |
| 4 | As needed | Add sanity checks | Automatic post-execution validation |

You don't need to adopt everything at once. Start with `validate`, and go deeper once you feel the value.

---

## Internal FAQ

### Q7: What Are This Project's Core Assumptions? What Happens If They're Wrong?

**A:** Our core assumptions:

| Assumption | Validation Method | If It's Wrong |
|------|----------|----------|
| 90% of teams have never tested a down migration | Confirmed via interviews with 50+ teams | Re-evaluate product positioning |
| Mandatory testing improves rollback success rate | Internal pilot data | Adjust testing strategy |
| Developers are willing to spend extra time writing sanity checks | Usage tracking | Simplify sanity check syntax or offer auto-generation |
| Kubernetes is the primary deployment environment | Market research | Strengthen support for other deployment methods |

**Biggest risk**: developers see it as unnecessary overhead and refuse to adopt it.

**Mitigation strategy**: incremental adoption + demonstrate value starting with validate.

---

### Q8: Why Not Use an Existing Open-Source Solution?

**A:** We evaluated the alternatives:

| Tool | Why It Falls Short |
|------|------------|
| Flyway | Only version control, no safety mechanism; primarily targets the Java ecosystem |
| Liquibase | Same as above, plus complex configuration |
| migrate-mongo | Only supports MongoDB, no dangerous-operation detection |
| sql-migrate | Only supports SQL, no Up-Down-Up testing |

**Key difference**: these tools solve "version control"; we solve "safety." These are different problems.

---

# Appendix A: Problem Scenarios

## Scenario 1: Friday Afternoon Nightmare

**Time**: Friday, 4:30 PM
**Situation**: Deploying a new release that includes a database migration

**MongoDB version:**
```javascript
// 20250121-add-payment-status.js
export const up = async (db) => {
  await db.collection('orders').updateMany(
    {},
    { $set: { paymentStatus: 'pending' } }
  );
};

export const down = async (db) => {
  await db.collection('orders').updateMany(
    {},
    { $unset: { paymentStatus: '' } }
  );
};
```

**MariaDB/MySQL version:**
```sql
-- 20250121-add-payment-status.sql
-- +migrate Up
ALTER TABLE orders ADD COLUMN payment_status VARCHAR(20) DEFAULT 'pending';
UPDATE orders SET payment_status = 'pending' WHERE payment_status IS NULL;

-- +migrate Down
ALTER TABLE orders DROP COLUMN payment_status;
```

**Something went wrong**: after deployment, it turned out old orders shouldn't have been set to `pending` — they should have kept their original state. A rollback was needed.

**Without db-migrate**:
1. Attempted to run the down migration → failed (because it had never been tested)
2. Found a bug in the down migration
3. Fixed the bug and redeployed → failed again
4. Manually wrote SQL to fix the data → took 3 hours
5. Didn't leave the office until 8:00 PM on Friday

**With db-migrate**:
1. This migration would be flagged as "high risk" at the PR stage
2. Code review would require adding a sanity check
3. If it were deployed anyway, postCheck would catch the problem and roll back automatically
4. Resolved within 5 minutes — home on time

---

## Scenario 2: A Junior Engineer's Mistake

**Situation**: A junior engineer needs to clean up test data

```sql
-- 20250121-cleanup-test-data.sql
-- +migrate Up
DROP TABLE test_users;
DROP TABLE test_orders;
DROP TABLE users;  -- Typo! Should be test_users

-- +migrate Down
-- Not written, since "it's just cleanup anyway"
```

**Without db-migrate**:
- Code review missed `DROP TABLE users`
- Deployed to staging... no problem (because staging's users table was test data anyway)
- Deployed to production... disaster

**With db-migrate**:
```
❌ VALIDATION FAILED

1. Dangerous operation detected:
   - Line 5: DROP TABLE users (not paired with CREATE)
   - Reason: 'users' was not created in this migration
   
2. Missing down migration:
   - No rollback script provided
   
Use --allow-dangerous to bypass (requires ADMIN approval)
```

Deployment blocked, crisis averted.

---

## Scenario 3: A Sanity Check Saves the Day

**Situation**: Adding a `verified` field to all users

**MongoDB version:**
```javascript
export const up = async (db) => {
  // Should use updateMany, but updateOne was used by mistake
  await db.collection('users').updateOne(
    {},
    { $set: { verified: false } }
  );
};

export const postCheck = async ({ db }) => {
  const total = await db.collection('users').countDocuments();
  const updated = await db.collection('users').countDocuments({ 
    verified: { $exists: true } 
  });
  
  if (updated !== total) {
    return { 
      success: false, 
      error: `Only ${updated}/${total} records were updated` 
    };
  }
  return { success: true };
};
```

**MariaDB/MySQL version:**
```sql
-- +migrate Up
-- Meant to update every row, but a typo left it updating only one
ALTER TABLE users ADD COLUMN verified BOOLEAN DEFAULT FALSE;
UPDATE users SET verified = FALSE WHERE id = 1;  -- Typo! Should be WHERE verified IS NULL

-- +sanity PostCheck
-- Validate that every user has a verified value
SELECT 
  CASE 
    WHEN (SELECT COUNT(*) FROM users WHERE verified IS NULL) = 0 THEN 1
    ELSE 0
  END AS success,
  CASE 
    WHEN (SELECT COUNT(*) FROM users WHERE verified IS NULL) > 0 
    THEN CONCAT('Only ', 
      (SELECT COUNT(*) FROM users WHERE verified IS NOT NULL), '/',
      (SELECT COUNT(*) FROM users), ' records were updated')
    ELSE NULL
  END AS error;
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE users DROP COLUMN verified;
```

**Execution result**:
```
✅ Migration executed
🔍 Running post-check...
❌ Post-check failed: Only 1/10000 records were updated
🔄 Auto-rollback triggered...
✅ Rollback completed
```

The problem was automatically fixed before it could cause impact.

---

# Appendix B: Quick Start

```bash
# 1. Clone the project
git clone https://github.com/i7ppBeer/ddl-migrate.git
cd ddl-migrate

# 2. Install dependencies
npm install

# 3. Run validation against existing migrations (experience the value in 5 minutes)
node src/cli.js -c your-project/config.js validate

# 4. Start the test environment and run the full test suite
docker compose up -d
npm test
```

## Additional Resources

- 📖 [Full technical documentation](./MIGRATION-MANAGEMENT-GUIDE.md)
- 🐳 [Local testing guide](./LOCAL-TEST-GUIDE.md)
- ☸️ [Kubernetes deployment guide](./BUILD-IMAGE-GUIDE.md)

---

*This is a Working Backwards document. Please confirm:*
1. *Is the pain point description accurate?*
2. *Does the solution address the problem?*
3. *Does the FAQ cover the main concerns?*
