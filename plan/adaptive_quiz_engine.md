# Adaptive Quiz Engine

**Goal**: Provide personalized quizzes that adapt to learner proficiency and schedule spaced‑repetition reviews.

**Key Features**:
- Item‑response theory based difficulty adjustment.
- Real‑time difficulty scaling.
- Adaptive question pool management.
- Spaced‑repetition scheduling algorithm.
- Progress tracking and mastery reporting.

**Implementation Steps**:
1. Define question metadata (difficulty, tags, learning objectives).
2. Implement algorithm to select next question based on response history.
3. Integrate with user profile to persist mastery levels.
4. Build scheduler that triggers review sessions at optimal intervals.
5. UI components for quiz display, progress bar, and results.

**Dependencies**: 
- Question bank management agent.
- Context files for question metadata.
- Workflow for quiz generation.