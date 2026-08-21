import { AUTO_BOOKING_PAYMENT_PLANS, TIMEZONE } from '@/config'
import PaymentModel from '@/models/payment.model'
import UserModel from '@/models/user.model'
import { sendMessageQueue } from '@/queues/broadcast.queue'
import {
  clearUserAutoBookingAccess,
  createAutoBookingPaymentLink,
  expirePayment,
  getActiveAutoBookingPayment,
  hasValidAutoBookingPayment
} from '@/services/payment.service'
import { emojis } from '@/utils/emoji.util'
import { logToChannel } from '@/utils/logger.util'
import { schedule } from 'node-cron'
import dayjs from '@/libs/dayjs.lib'
import { inlineKeyboard, Markup } from 'telegraf/markup'
import { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram'
import cacheService from '@/services/cache.service'

const notifyExpiredPayments = async () => {
  const now = new Date()
  const expiredPayments = await PaymentModel.find({
    status: 'paid',
    validUntil: {
      $lte: now
    }
  })

  const userIds = new Set<string>()

  for (const payment of expiredPayments) {
    userIds.add(payment.user.toString())
    await expirePayment(payment)
  }

  for (const userId of userIds) {
    const hasValidPayment = await hasValidAutoBookingPayment(userId)
    if (hasValidPayment) {
      continue
    }

    const user = await UserModel.findById(userId)
    if (!user) {
      continue
    }

    await clearUserAutoBookingAccess(user)

    if (user.tgId) {
      await sendMessageQueue({
        chatId: user.tgId,
        text: [
          `<b>${emojis.siren} Auto-booking payment expired</b>`,
          `Your auto-booking access has expired, so your auto-booking products were cleared and your Amul session was logged out.`,
          ``,
          `To continue using auto-booking, please renew your payment from /autoorder.`
        ].join('\n')
      })
    }
  }

  if (expiredPayments.length) {
    logToChannel(
      `${emojis.info} Expired ${expiredPayments.length} auto-booking payment(s).`
    )
  }
}

const notifyForRemainingDays = async (remainingDays: number) => {
  const timestamp = dayjs().add(remainingDays, 'day')
  const timestampDateKey = dayjs(timestamp).format('YYYY-MM-DD')
  const payments = await PaymentModel.find({
    status: 'paid',
    validUntil: {
      $gte: timestamp.startOf('day').toDate(),
      $lt: timestamp.add(1, 'day').startOf('day').toDate()
    }
  })

  for (const payment of payments) {
    const user = await UserModel.findById(payment.user)
    if (!user) {
      continue
    }

    // get current valid payment for user
    const currentPayment = await getActiveAutoBookingPayment(user._id)
    if (
      !currentPayment ||
      currentPayment._id.toString() !== payment._id.toString()
    ) {
      continue
    }

    if (user.tgId) {
      const alreadyNotified = await cacheService.expiryNotification.get({
        tgId: user.tgId,
        paymentId: currentPayment._id.toString(),
        remainingDays
      })

      if (alreadyNotified) {
        continue
      }

      const currentPlan = AUTO_BOOKING_PAYMENT_PLANS.find(
        (plan) => plan.amount === currentPayment.amount
      )

      const keyboard: Markup<InlineKeyboardMarkup> | undefined = currentPlan
        ? inlineKeyboard([
            {
              text: `${emojis.moneyBag} Renew Payment | ${currentPlan?.label}`,
              url: (await createAutoBookingPaymentLink(user, currentPlan))
                .shortUrl
            }
          ])
        : undefined

      await sendMessageQueue({
        chatId: user.tgId,
        text: [
          `${emojis.warning} <b>${emojis.lightning} Auto-booking payment expiring soon</b>`,
          `Your auto-booking access will expire in ${remainingDays} day(s).`,
          `Keep your products tracked and auto-booking active by renewing your payment.`,
          ``,
          `To continue using auto-booking, please renew your payment from /autoorder.`
        ].join('\n'),
        extra: {
          reply_markup: keyboard?.reply_markup ?? undefined
        }
      })
      await cacheService.expiryNotification.set(
        {
          tgId: user.tgId,
          paymentId: currentPayment._id.toString(),
          remainingDays
        },
        {
          datekey: timestampDateKey
        }
      )
    }
  }
}

const paymentExpiryJob = schedule(
  '* * * * *',
  async () => {
    try {
      await notifyExpiredPayments()
    } catch (err) {
      console.error('Error in payment-expiry-job:', err)
      logToChannel(
        `${emojis.crossMark} Error in payment-expiry-job: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  },
  {
    timezone: TIMEZONE,
    name: 'payment-expiry-job'
  }
)

const incomingExpiryNotificationJob = schedule(
  // everyday at 10:00 AM
  '0 10 * * *',
  async () => {
    try {
      const NOTIFY_BEFORE_DAYS = [3, 2, 1]
      for (const days of NOTIFY_BEFORE_DAYS) {
        await notifyForRemainingDays(days)
      }
    } catch (err) {
      console.error('Error in incoming-expiry-notification-job:', err)
      logToChannel(
        `${emojis.crossMark} Error in incoming-expiry-notification-job: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  },
  {
    timezone: TIMEZONE,
    name: 'incoming-expiry-notification-job'
  }
)

export { paymentExpiryJob, incomingExpiryNotificationJob }
