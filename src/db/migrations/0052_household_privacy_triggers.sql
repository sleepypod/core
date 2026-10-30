-- Protect existing installations before any legacy endpoint can serve shared data.
INSERT OR IGNORE INTO household_privacy_boundary (id, required_at, reason)
SELECT 1, unixepoch() * 1000, 'existing_personal_arrangement'
WHERE EXISTS (SELECT 1 FROM households WHERE mode = 'assigned')
   OR EXISTS (SELECT 1 FROM household_accounts WHERE assigned_side IS NOT NULL)
   OR EXISTS (SELECT 1 FROM household_attribution_epochs WHERE mode = 'assigned')
   OR EXISTS (SELECT 1 FROM household_person_records record JOIN household_accounts account
              ON account.sleeper_id = record.sleeper_id WHERE account.role = 'member');
--> statement-breakpoint
CREATE TRIGGER household_privacy_no_delete BEFORE DELETE ON household_privacy_boundary
BEGIN SELECT RAISE(ABORT, 'Personal privacy boundary cannot be removed'); END;
--> statement-breakpoint
CREATE TRIGGER household_privacy_no_update BEFORE UPDATE ON household_privacy_boundary
BEGIN SELECT RAISE(ABORT, 'Personal privacy boundary cannot be changed'); END;
--> statement-breakpoint
CREATE TRIGGER household_privacy_arrangement_insert AFTER INSERT ON households WHEN NEW.mode = 'assigned'
BEGIN INSERT OR IGNORE INTO household_privacy_boundary VALUES (1, unixepoch() * 1000, 'assigned_arrangement'); END;
--> statement-breakpoint
CREATE TRIGGER household_privacy_arrangement_update AFTER UPDATE OF mode ON households WHEN NEW.mode = 'assigned'
BEGIN INSERT OR IGNORE INTO household_privacy_boundary VALUES (1, unixepoch() * 1000, 'assigned_arrangement'); END;
--> statement-breakpoint
CREATE TRIGGER household_privacy_account_insert AFTER INSERT ON household_accounts WHEN NEW.assigned_side IS NOT NULL
BEGIN INSERT OR IGNORE INTO household_privacy_boundary VALUES (1, unixepoch() * 1000, 'assigned_account'); END;
--> statement-breakpoint
CREATE TRIGGER household_privacy_account_update AFTER UPDATE OF assigned_side ON household_accounts WHEN NEW.assigned_side IS NOT NULL
BEGIN INSERT OR IGNORE INTO household_privacy_boundary VALUES (1, unixepoch() * 1000, 'assigned_account'); END;
--> statement-breakpoint
CREATE TRIGGER household_privacy_epoch_insert AFTER INSERT ON household_attribution_epochs WHEN NEW.mode = 'assigned'
BEGIN INSERT OR IGNORE INTO household_privacy_boundary VALUES (1, unixepoch() * 1000, 'assigned_attribution'); END;
--> statement-breakpoint
CREATE TRIGGER household_privacy_epoch_update AFTER UPDATE OF mode ON household_attribution_epochs WHEN NEW.mode = 'assigned'
BEGIN INSERT OR IGNORE INTO household_privacy_boundary VALUES (1, unixepoch() * 1000, 'assigned_attribution'); END;
--> statement-breakpoint
CREATE TRIGGER household_privacy_record_insert AFTER INSERT ON household_person_records
WHEN EXISTS (SELECT 1 FROM household_accounts WHERE sleeper_id = NEW.sleeper_id AND role = 'member')
BEGIN INSERT OR IGNORE INTO household_privacy_boundary VALUES (1, unixepoch() * 1000, 'member_observation'); END;
--> statement-breakpoint
CREATE TRIGGER household_privacy_record_update AFTER UPDATE OF sleeper_id ON household_person_records
WHEN EXISTS (SELECT 1 FROM household_accounts WHERE sleeper_id = NEW.sleeper_id AND role = 'member')
BEGIN INSERT OR IGNORE INTO household_privacy_boundary VALUES (1, unixepoch() * 1000, 'member_observation'); END;
