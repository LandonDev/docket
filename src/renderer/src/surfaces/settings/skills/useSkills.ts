import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { StoreHome } from "@shared/contract-addons";
import type { SkillMeta, SkillsList } from "@shared/contract-skills";
import type { Link } from "../../../lib/connection";
import { useHostRead } from "../../../lib/connection/hostRead";
import { useRecheckWhileOffline } from "../../../lib/settingsHome";
import { registry } from "../../../lib/connection";
import { byNameThenScope, useAskAgainOnLinks } from "../addons/useAddons";
import { searchNames } from "../parts/searchNames";

/** Every skill's name for Settings' search (`useSearchResults`), each opening Skills. */
export const skillNames = searchNames("skills", "Everywhere, Skills", () =>
  registry
    .primary()
    .request<SkillsList>("skills.list", { workspaceId: null })
    .then((list) => list.skills.map((skill) => skill.name)),
);

export interface SkillsPageData {
  /** sorted by name, then the global row before a workspace's */
  skills: SkillMeta[];
  /** the every-workspace scope's home */
  home: StoreHome;
}

/**
 * Settings → Skills' read: `skills.list`, with the `skills` push folded in
 * (dropped before the first answer, which holds it), asked again when a
 * host's link comes or goes so the home note says where the copy is.
 */
export function useSkillsPage(link: Link) {
  const main = useHostRead<SkillsList>(link, () => link.request<SkillsList>("skills.list", { workspaceId: null }));
  const ref = useRef(main.value);
  useLayoutEffect(() => {
    ref.current = main.value;
  }, [main.value]);
  const { set, retry } = main;
  const put = useCallback(
    (next: SkillsList) => {
      ref.current = next;
      set(next);
    },
    [set],
  );
  useEffect(
    () =>
      link.onPush((push) => {
        if (push.push === "skills" && ref.current) put({ ...ref.current, skills: push.skills });
      }),
    [link, put],
  );
  useAskAgainOnLinks(retry);
  useRecheckWhileOffline(main.value?.home, retry);

  const replaceRow = useCallback(
    (row: SkillMeta) => {
      const cur = ref.current;
      if (cur) put({ ...cur, skills: [...cur.skills.filter((s) => s.id !== row.id), row] });
    },
    [put],
  );
  const dropRow = useCallback(
    (id: string) => {
      const cur = ref.current;
      if (cur) put({ ...cur, skills: cur.skills.filter((s) => s.id !== id) });
    },
    [put],
  );

  const value = main.value;
  useEffect(() => {
    if (value) skillNames.set(value.skills.map((skill) => skill.name));
  }, [value]);
  const skills = useMemo(() => (value ? [...value.skills].sort(byNameThenScope) : []), [value]);
  const data: SkillsPageData | undefined = value ? { skills, home: value.home } : undefined;
  return { data, error: main.error, retry, replaceRow, dropRow };
}
