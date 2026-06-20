// Exact GraphQL queries for phase-1 read. Native relations are selected here so
// discoverLinks can prefer them over regex (DESIGN §4).

export const GET_ISSUE = `query GetIssue($owner: String!, $repo: String!, $number: Int!, $timelineCount: Int = 100, $afterTimeline: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number title body state stateReason createdAt updatedAt
      author { login __typename }
      assignees(first: 20) { nodes { login } }
      labels(first: 50) { nodes { name } }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { number repository { nameWithOwner } state } }
      parent { number title repository { nameWithOwner } }
      subIssues(first: 50) { nodes { number title repository { nameWithOwner } state } }
      subIssuesSummary { total completed percentCompleted }
      blockedBy(first: 50) { nodes { number repository { nameWithOwner } } }
      blocking(first: 50) { nodes { number repository { nameWithOwner } } }
      issueDependenciesSummary { blockedBy totalBlockedBy blocking totalBlocking }
      timelineItems(first: $timelineCount, after: $afterTimeline, itemTypes: [ISSUE_COMMENT, CROSS_REFERENCED_EVENT, CONNECTED_EVENT, DISCONNECTED_EVENT, CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, MENTIONED_EVENT, RENAMED_TITLE_EVENT, SUB_ISSUE_ADDED_EVENT, SUB_ISSUE_REMOVED_EVENT, PARENT_ISSUE_ADDED_EVENT, PARENT_ISSUE_REMOVED_EVENT, BLOCKED_BY_ADDED_EVENT, BLOCKED_BY_REMOVED_EVENT, BLOCKING_ADDED_EVENT, BLOCKING_REMOVED_EVENT, MARKED_AS_DUPLICATE_EVENT]) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on IssueComment { author { login } createdAt body }
          ... on CrossReferencedEvent { actor { login } createdAt willCloseTarget source { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
          ... on ConnectedEvent { actor { login } createdAt subject { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
          ... on DisconnectedEvent { actor { login } createdAt subject { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
          ... on ClosedEvent { actor { login } createdAt stateReason closer { __typename ... on PullRequest { number repository { nameWithOwner } } ... on Commit { oid } } }
          ... on ReopenedEvent { actor { login } createdAt }
          ... on LabeledEvent { actor { login } createdAt label { name } }
          ... on UnlabeledEvent { actor { login } createdAt label { name } }
          ... on AssignedEvent { actor { login } createdAt assignee { __typename ... on User { login } } }
          ... on UnassignedEvent { actor { login } createdAt assignee { __typename ... on User { login } } }
          ... on MentionedEvent { actor { login } createdAt }
          ... on RenamedTitleEvent { actor { login } createdAt previousTitle currentTitle }
          ... on SubIssueAddedEvent { actor { login } createdAt subIssue { number repository { nameWithOwner } } }
          ... on SubIssueRemovedEvent { actor { login } createdAt subIssue { number repository { nameWithOwner } } }
          ... on ParentIssueAddedEvent { actor { login } createdAt parent { number repository { nameWithOwner } } }
          ... on ParentIssueRemovedEvent { actor { login } createdAt parent { number repository { nameWithOwner } } }
          ... on BlockedByAddedEvent { actor { login } createdAt }
          ... on BlockedByRemovedEvent { actor { login } createdAt }
          ... on BlockingAddedEvent { actor { login } createdAt }
          ... on BlockingRemovedEvent { actor { login } createdAt }
          ... on MarkedAsDuplicateEvent { actor { login } createdAt canonical { __typename ... on Issue { number repository { nameWithOwner } } } }
        }
      }
    }
  }
}`;

export const GET_PULL_REQUEST = `query GetPullRequest($owner: String!, $repo: String!, $number: Int!, $timelineCount: Int = 100, $afterTimeline: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title body state isDraft merged mergedAt reviewDecision createdAt updatedAt
      author { login __typename }
      assignees(first: 20) { nodes { login } }
      labels(first: 50) { nodes { name } }
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }
      reviews(first: 50) { nodes { author { login } state submittedAt body } }
      latestReviews(first: 50) { nodes { author { login } state submittedAt } }
      reviewThreads(first: 50) { pageInfo { hasNextPage endCursor } nodes { isResolved isOutdated path comments(first: 30) { nodes { author { login } body createdAt } } } }
      closingIssuesReferences(first: 20) { nodes { number repository { nameWithOwner } } }
      timelineItems(first: $timelineCount, after: $afterTimeline, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, CROSS_REFERENCED_EVENT, CONNECTED_EVENT, DISCONNECTED_EVENT, LABELED_EVENT, ASSIGNED_EVENT, RENAMED_TITLE_EVENT]) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on IssueComment { author { login } createdAt body }
          ... on PullRequestReview { author { login } createdAt submittedAt state body }
          ... on ReviewRequestedEvent { actor { login } createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
          ... on ReviewRequestRemovedEvent { actor { login } createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
          ... on ReadyForReviewEvent { actor { login } createdAt }
          ... on ConvertToDraftEvent { actor { login } createdAt }
          ... on MergedEvent { actor { login } createdAt commit { oid } }
          ... on ClosedEvent { actor { login } createdAt }
          ... on ReopenedEvent { actor { login } createdAt }
          ... on CrossReferencedEvent { actor { login } createdAt willCloseTarget source { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
          ... on ConnectedEvent { actor { login } createdAt subject { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
          ... on DisconnectedEvent { actor { login } createdAt subject { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
          ... on LabeledEvent { actor { login } createdAt label { name } }
          ... on RenamedTitleEvent { actor { login } createdAt previousTitle currentTitle }
        }
      }
    }
  }
}`;

export const LIST_THREADS_BY_REPO = `query ListRepoThreads($owner: String!, $repo: String!, $issuesAfter: String, $prsAfter: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: 50, after: $issuesAfter, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number repository { nameWithOwner } }
    }
    pullRequests(first: 50, after: $prsAfter, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number repository { nameWithOwner } isDraft }
    }
  }
}`;
