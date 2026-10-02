'use client'

import { usePathname, useRouter } from 'next/navigation'
import { trpc } from '@/src/utils/trpc'
import { Card, InlineError, Skeleton } from '@/src/components/ds'
import { RuleEditor } from './RuleEditor'
import { type BuilderRule, blankRule, fromAST, templateRule, toAST } from './builderModel'

/**
 * /autopilot/<id> and /autopilot/new: loads the rule (or a blank one), saves
 * via create/update, and returns to the Automations list on Save or Cancel.
 * `/autopilot/new?template=<id>` opens the editor prefilled from a template.
 */
export function RulePage({ id, template }: { id: string, template?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const lang = pathname?.split('/')[1] || 'en'
  const utils = trpc.useUtils()
  const isNew = id === 'new'
  const numericId = Number(id)
  const validId = !isNew && Number.isInteger(numericId) && numericId > 0

  const ruleQ = trpc.automations.get.useQuery({ id: numericId }, { enabled: validId })

  const back = () => router.push(`/${lang}/autopilot`)
  const onSaved = () => {
    void utils.automations.list.invalidate()
    void utils.automations.status.invalidate()
    back()
  }
  const createM = trpc.automations.create.useMutation({ onSuccess: onSaved })
  const updateM = trpc.automations.update.useMutation({ onSuccess: onSaved })

  const save = (rule: BuilderRule) => {
    const ast = toAST(rule)
    if (rule.id != null) updateM.mutate({ id: rule.id, ...ast })
    else createM.mutate(ast)
  }

  if (!isNew && !validId) {
    return <Card><InlineError>{`No automation "${id}".`}</InlineError></Card>
  }
  if (validId && ruleQ.isLoading) return <Skeleton className="h-[520px]" />
  const row = ruleQ.data
  if (!isNew && !row) {
    return <Card><InlineError>{ruleQ.error?.message ?? `Automation ${id} not found`}</InlineError></Card>
  }

  const automation = row ? fromAST(row) : (templateRule(template) ?? blankRule())
  const saveError = createM.error ?? updateM.error

  return (
    <>
      {saveError && <Card><InlineError>{`Failed to save: ${saveError.message}`}</InlineError></Card>}
      <RuleEditor
        key={id}
        automation={automation}
        onClose={back}
        onSave={save}
        saving={createM.isPending || updateM.isPending}
      />
    </>
  )
}
