-- Make preference capture idempotent (DESIGN §8): repeating "mute repo X" or
-- re-snoozing updates the existing row instead of accumulating duplicates.
CREATE UNIQUE INDEX idx_preferences_unique ON preferences (person, rule, selector);
