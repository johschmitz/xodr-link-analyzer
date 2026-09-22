// Issues list overlay: grouped, filterable by class, click-to-focus.

function issueToText(issue) {
    return `[${issue.severity.toUpperCase()}] ${issue.title}\n${issue.detail}`;
}

async function copyText(text, button) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            // Fallback for non-secure contexts (e.g. http://localhost via IP).
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            textarea.remove();
        }
        const original = button.textContent;
        button.textContent = "✓";
        setTimeout(() => {
            button.textContent = original;
        }, 1000);
        return true;
    } catch {
        showToast("Copy failed — clipboard not available");
        return false;
    }
}

// Toast notifications (bottom center).
let toastContainer = null;

function ensureToastContainer() {
    if (!toastContainer) {
        toastContainer = document.createElement("div");
        toastContainer.className = "toast-container";
        document.body.appendChild(toastContainer);
    }
    return toastContainer;
}

export function showToast(message) {
    const container = ensureToastContainer();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add("toast-hide");
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

export function createErrorPanel({ listElement, filterCheckboxes, onSelect }) {
    let issues = [];
    let selectedId = null;
    const enabledClasses = new Set();

    // Ids of the issues currently visible after filtering, in display order —
    // the sequence ArrowUp/ArrowDown steps through.
    let visibleIds = [];

    function setIssues(newIssues) {
        issues = newIssues;
        selectedId = null;
        syncFilterClasses();
        render();
    }

    // All known issue classes, always shown in the filter list. Classes with
    // zero occurrences are grayed out and their checkbox disabled.
    const ALL_ISSUE_CLASSES = [
        // Road links
        "Contact point gap at connection",
        "Duplicate element id",
        "Missing road link target",
        "No road entry in junction connections",
        "Overlapping roads",
        "Road contact point mismatch",
        "Road declared as junction but is a road",
        "Road elevation step",
        "Road heading discontinuity",
        "Road width mismatch",
        "Unidirectional road link",
        // Lane links
        "Center lane link across roads",
        "Lane type mismatch",
        "Lane link lateral jump",
        "Missing lane link target",
        "Missing lane link target at section transition",
        "Unidirectional lane link",
        // Junction lane links
        "Connecting road lane link mismatch",
        "Duplicate junction laneLink",
        "Junction connection without incoming link",
        "Incoming road lane link",
        "Junction laneLink for outgoing direction",
        "Junction laneLink from unknown lane",
        "Junction laneLink to unknown lane",
        "Missing reverse lane link on connecting road",
        "Missing outgoing lane link on connecting road",
        "Outgoing lane link on junction arm",
        "Unidirectional junction laneLink",
    ];

    // Keep a checkbox per issue class; gray out classes not present.
    function syncFilterClasses() {
        const classes = new Map();
        for (const issue of issues) {
            classes.set(issue.title, (classes.get(issue.title) || 0) + 1);
        }

        for (const title of Array.from(enabledClasses)) {
            if (!classes.has(title)) {
                enabledClasses.delete(title);
            }
        }

        filterCheckboxes.innerHTML = "";
        const sorted = Array.from(classes.entries())
            .concat(ALL_ISSUE_CLASSES.filter((t) => !classes.has(t)).map((t) => [t, 0]))
            .sort((a, b) => a[0].localeCompare(b[0]));

        for (const [title, count] of sorted) {
            const exists = count > 0;
            const label = document.createElement("label");
            label.className = exists ? "filter-item" : "filter-item filter-item-empty";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = !enabledClasses.has(title);
            checkbox.disabled = !exists;
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) {
                    enabledClasses.delete(title);
                } else {
                    enabledClasses.add(title);
                }
                render();
            });

            const text = document.createElement("span");
            text.textContent = exists ? `${title} (${count})` : title;

            label.append(checkbox, text);
            filterCheckboxes.appendChild(label);
        }
    }

    function selectIssue(id) {
        selectedId = id;
        render();
        scrollSelectedIntoView();
        const issue = issues.find((i) => i.id === id);
        if (issue) {
            onSelect(issue);
        }
    }

    // Keep the highlighted row visible in the scrollable list (used by both
    // click-selection and arrow-key stepping).
    function scrollSelectedIntoView() {
        const row = listElement.querySelector(`.issue-row.selected`);
        if (row) {
            row.scrollIntoView({ block: "nearest" });
        }
    }

    // Highlight the issue in the list without moving the camera (used when
    // the user clicks a disc in the 3D view, which supplies its own focus).
    function selectIssueSilently(id) {
        const issue = issues.find((item) => item.id === id);
        if (issue && enabledClasses.delete(issue.title)) {
            syncFilterClasses();
            showToast(`Enabled issue filter: ${issue.title}`);
        }
        selectedId = id;
        render();
        scrollSelectedIntoView();
    }

    // Clear the selection (used when clicking a marker without an issue).
    function deselect() {
        selectedId = null;
        render();
    }

    // Step through the visible issues with ArrowUp/ArrowDown once one is
    // selected; behaves exactly like clicking the rows (camera flies along).
    document.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
            return;
        }
        const target = event.target;
        if (target instanceof HTMLElement
            && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
            return; // don't hijack arrows while typing in a field
        }
        if (selectedId == null || visibleIds.length === 0) {
            return;
        }
        const index = visibleIds.indexOf(selectedId);
        if (index === -1) {
            return;
        }
        const next = event.key === "ArrowDown"
            ? Math.min(index + 1, visibleIds.length - 1)
            : Math.max(index - 1, 0);
        if (next !== index) {
            event.preventDefault();
            selectIssue(visibleIds[next]);
        }
    });

    function render() {
        listElement.innerHTML = "";

        if (issues.length === 0) {
            const empty = document.createElement("div");
            empty.className = "issue-empty";
            empty.textContent = "No issues found — all links verified.";
            listElement.appendChild(empty);
            return;
        }

        const filtered = issues.filter((issue) => !enabledClasses.has(issue.title));

        const groups = new Map();
        for (const issue of filtered) {
            if (!groups.has(issue.category)) {
                groups.set(issue.category, []);
            }
            groups.get(issue.category).push(issue);
        }
        visibleIds = [];

        const categoryLabels = { road: "Road links", lane: "Lane links", geometry: "Geometry" };
        const categoryOrder = { road: 0, lane: 1, geometry: 2 };
        const severityIcons = { error: "⛔", warning: "⚠️", info: "ℹ️" };

        const sortedCategories = Array.from(groups.keys()).sort((a, b) =>
            (categoryOrder[a] ?? 99) - (categoryOrder[b] ?? 99)
        );

        for (const category of sortedCategories) {
            const categoryIssues = groups.get(category)
                .slice()
                .sort((a, b) => a.title.localeCompare(b.title) || a.detail.localeCompare(b.detail));
            const title = document.createElement("div");
            title.className = "issue-group-title";
            title.textContent = `${categoryLabels[category] || category} (${categoryIssues.length})`;
            listElement.appendChild(title);

            for (const issue of categoryIssues) {
                visibleIds.push(issue.id);
                const row = document.createElement("div");
                row.className = `issue-row severity-${issue.severity}`;
                if (issue.id === selectedId) {
                    row.classList.add("selected");
                }

                const icon = document.createElement("span");
                icon.className = "issue-icon";
                icon.textContent = severityIcons[issue.severity] || "•";

                const body = document.createElement("div");
                body.className = "issue-body";
                const titleEl = document.createElement("div");
                titleEl.className = "issue-title";
                titleEl.textContent = issue.title;
                const detailEl = document.createElement("div");
                detailEl.className = "issue-detail";
                detailEl.textContent = issue.detail;
                body.append(titleEl, detailEl);

                row.append(icon, body);

                if (issue.id === selectedId) {
                    const copyBtn = document.createElement("button");
                    copyBtn.className = "ghost issue-copy-btn";
                    copyBtn.type = "button";
                    copyBtn.title = "Copy issue as text";
                    copyBtn.textContent = "⧉";
                    copyBtn.addEventListener("click", (event) => {
                        event.stopPropagation();
                        copyText(issueToText(issue), copyBtn).then((ok) => {
                            if (ok) {
                                showToast("Issue copied to clipboard");
                            }
                        });
                    });
                    row.append(copyBtn);
                }

                row.addEventListener("click", () => selectIssue(issue.id));
                listElement.appendChild(row);
            }
        }
    }

    function copyAllIssues(button) {
        if (issues.length === 0) {
            return;
        }
        const filtered = issues.filter((issue) => !enabledClasses.has(issue.title));
        const text = filtered.map((issue, i) => `${i + 1}. ${issueToText(issue)}`).join("\n\n");
        copyText(text, button).then((ok) => {
            if (ok) {
                showToast(`${filtered.length} issue${filtered.length === 1 ? "" : "s"} copied to clipboard`);
            }
        });
    }

    return { setIssues, selectIssue, selectIssueSilently, deselect, copyAllIssues };
}
