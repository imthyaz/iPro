# Backup and restore runbook

Slice 14 done-when #4; decision #98. Use it for the restore test before go-live, then every quarter, and
for a real restore.

## What is backed up

| What | How | Kept | Where |
| --- | --- | --- | --- |
| Database (RDS PostgreSQL) | Automated backups with point-in-time recovery: transaction logs every 5 minutes | 35 days (prod), 7 days (staging, dev) | Mumbai, replicated to Hyderabad |
| Database | Nightly AWS Backup at 02:00 IST, finished within 4 hours | Same as above | Mumbai vault `ipro-<stage>`, copied to Hyderabad vault `ipro-<stage>-dr` |
| Documents (S3) | Versioned bucket, plus the same nightly AWS Backup | Same as above | Same vaults |
| Field-encryption key (KYC, pay) | Multi-Region KMS key with a Hyderabad replica (`alias/ipro-<stage>-fields`) | Never deleted | Mumbai and Hyderabad |

Targets (spec): lose no more than **15 minutes** of data and be back within **4 hours**.
Point-in-time recovery loses about 5 minutes. A Hyderabad restore uses the replicated automated
backups, so it loses minutes too; the nightly copy is the fallback.

Everything stays in India (ap-south-1 and ap-south-2).

## Restore test (staging; before go-live, then quarterly)

You restore staging's own backup to a **new** instance, check it, then delete it. Staging is never
overwritten. Use a machine in the staging VPC (for example an ECS task or a bastion) and the
`ipro-staging` AWS profile. Write down the time at each step: the total is the recovery time.

1. **Choose the points in time.**
   - Restore point **R**: at least 15 minutes ago (the latest restorable time is shown by
     `aws rds describe-db-instances --db-instance-identifier <staging-db> --query
     "DBInstances[0].LatestRestorableTime"`).
   - Cut-off **C** = R minus 10 minutes. Rows created up to C are compared.
   - Don't run it while the weekly retention job runs: it removes rows on purpose.

2. **Take the source manifest** (counts and id hashes only, no personal data):

   ```powershell
   $env:DATABASE_URL = "<staging database url>"
   pnpm --filter @ipro/api ops:restore-check manifest --cutoff <C> --out source.json
   ```

3. **Restore to a new instance** at R, in the staging data subnets, not publicly accessible:

   ```powershell
   aws rds restore-db-instance-to-point-in-time `
     --source-db-instance-identifier <staging-db> `
     --target-db-instance-identifier ipro-staging-restore-<yyyymmdd> `
     --restore-time <R> `
     --db-subnet-group-name <staging data subnet group> `
     --vpc-security-group-ids <staging database security group> `
     --no-publicly-accessible
   aws rds wait db-instance-available --db-instance-identifier ipro-staging-restore-<yyyymmdd>
   ```

4. **Verify the data** against the manifest:

   ```powershell
   $env:DATABASE_URL = "<restored database url>"
   pnpm --filter @ipro/api ops:restore-check verify --manifest source.json
   ```

   It must print `Restore verified`. Anything else lists the tables that differ: stop and investigate.

5. **Verify the app on it.** Run one API task against the restored database: the staging task
   definition with `DATABASE_URL` overridden, and `JOBS_ENABLED=false` so no reminders or jobs fire
   from the copy. Then, as a synthetic HR user:
   - open a person record;
   - unmask a KYC value and open a compensation row (this proves the field key decrypts);
   - open a document (this proves the documents bucket is reachable).

6. **Restore one document** from the nightly backup to a scratch bucket (AWS Backup console, Restore,
   item-level restore), and open it.

7. **Record the result** in the release notes: date, R, C, the verify output, total time (target under
   4 hours) and who ran it.

8. **Clean up**: stop the API task, then delete the restored instance without a final snapshot.
   It is a copy:

   ```powershell
   aws rds delete-db-instance --db-instance-identifier ipro-staging-restore-<yyyymmdd> `
     --skip-final-snapshot
   ```

### Hyderabad drill (at go-live, then yearly)

Run the same test, restoring in **ap-south-2** from the replicated automated backups:

```powershell
aws rds restore-db-instance-to-point-in-time --region ap-south-2 `
  --source-db-instance-automated-backups-arn <replicated backup arn> `
  --target-db-instance-identifier ipro-staging-dr-restore-<yyyymmdd> `
  --restore-time <R> --no-publicly-accessible
```

At step 5, use the Hyderabad replica of the field key (same alias). Clean up the same way.

## Real restore (production)

1. **Decide the point in time.** Pick just before the problem (bad deploy, wrong bulk change) or the
   latest restorable time (lost instance). Note it in the incident log.
2. **Restore to a new instance** as in step 3, in Mumbai, or in Hyderabad if Mumbai is unavailable.
3. **Verify it** as in steps 4 and 5. Take the manifest from the damaged database if it is still
   readable, with a cut-off before the problem.
4. **Switch the app:** point the `DATABASE_URL` secret at the restored instance and redeploy the API.
   Keep the old instance, stopped, until the incident is closed.
5. **Tell people** what was lost between the restore point and the incident. Changes made in that
   window are re-entered from the audit log and the requests and journey views.

Production restores need the HR head and the engineering lead to agree, and are recorded in the
audit trail of the incident.
