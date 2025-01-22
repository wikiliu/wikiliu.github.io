
自己有两个local 别人也有两个local 如何cherry pick 并merge upstream？

1. git fetch origin refs/changes/45/12345/1
2. git checkout -b temp-branch FETCH_HEAD
3. git checkout feature-branch && git rebase temp-branch
4. git merge upstream/main


或者用 git cherry-pick commit1^..commit3 前提是你知道分叉点在哪

