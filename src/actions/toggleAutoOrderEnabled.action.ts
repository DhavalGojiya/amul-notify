import { autoOrderCommand } from '@/commands/autoorder.command'
import {
  ACTIONS,
  AUTO_BOOKING_PAYMENT_PLANS,
  AutoBookingPaymentPlan
} from '@/config'
import {
  getActiveAutoBookingPayment,
  hasValidAutoBookingPayment
} from '@/services/payment.service'
import { ActionContext } from '@/types/context.types'
import {
  buildAutoOrderPaymentMessage,
  buildAutoOrderPaymentPlansKeyboard,
  isAutoOrderConfigured
} from '@/utils/autoOrder.util'
import { cloneDeep } from '@/utils/cloneDeep.util'
import { MiddlewareFn } from 'telegraf'

export const toggleAutoOrderEnabledAction: MiddlewareFn<ActionContext> = async (
  ctx,
  next
) => {
  if (!isAutoOrderConfigured()) {
    await ctx.answerCbQuery('Auto-ordering is not configured')
    return next()
  }

  const currentStatus = ctx.user?.orderSettings.enabled || false
  const newStatus = !currentStatus

  const isRenewing =
    ctx.updateType === 'callback_query' &&
    ctx.callbackQuery &&
    'data' in ctx.callbackQuery
      ? ctx.callbackQuery.data === ACTIONS.settings.autoOrder.renewPlan
      : false

  if (newStatus || isRenewing) {
    const hasValidPayment = await hasValidAutoBookingPayment(ctx.user._id)

    if (!hasValidPayment || isRenewing) {
      const currentPlan = await getActiveAutoBookingPayment(ctx.user._id)

      const clonedPlans = cloneDeep(AUTO_BOOKING_PAYMENT_PLANS)

      const plans: AutoBookingPaymentPlan[] = currentPlan
        ? clonedPlans.filter(
            // show all plans greater than or equal to current plan
            (plan) => plan.amount >= currentPlan.amount
          )
        : clonedPlans

      const keyboard = await buildAutoOrderPaymentPlansKeyboard(ctx.user, plans)

      await ctx.answerCbQuery('Payment required')
      await ctx.reply(buildAutoOrderPaymentMessage(), {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup
      })

      return next()
    }
  }

  ctx.user.set('orderSettings.enabled', newStatus)
  await ctx.user.save()

  return autoOrderCommand(ctx, next)
}
