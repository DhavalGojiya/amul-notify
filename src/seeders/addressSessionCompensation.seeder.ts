import bot from '@/bot'
import { TIMEZONE } from '@/config'
import env from '@/env'
import dayjs from '@/libs/dayjs.lib'
import PaymentModel, { HydratedPayment } from '@/models/payment.model'
import UserModel, { HydratedUser } from '@/models/user.model'
import mongoose from 'mongoose'

const PAID_COMPENSATION_DAYS = 30
const FREE_COMPENSATION_DAYS = 15
const COMPENSATION_SOURCE = 'address_session_issue_compensation_2026'

type CompensationType = 'paid_extension' | 'free_access'

interface CompensationDetails {
  type: CompensationType
  durationInDays: number
  validUntil: Date
}

const buildReferenceId = (user: HydratedUser): string => {
  return `ab_compensation_address_session_${user._id.toString()}`
}

const addDays = (date: Date, days: number): Date => {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

const formatValidUntil = (date: Date): string => {
  return dayjs(date).tz(TIMEZONE).format('DD MMM YYYY, hh:mm A')
}

const buildMessage = (details: CompensationDetails): string => {
  const reward =
    details.type === 'paid_extension'
      ? `I have extended your auto-booking access by <b>${details.durationInDays} days</b>.`
      : `I have given you <b>${details.durationInDays} days</b> of auto-booking access for free.`

  return [
    '⚠️ <b>Apologies for the inconvenience</b>',
    "I've identified and fixed an issue that could show incorrect address details while setting up auto-ordering. Also fixing the order placing E454 error that many users faced.",
    '',
    '⭐ <b>Your compensation</b>',
    `${reward} This is on us as an apology for the inconvenience.`,
    `Your access is valid until: <b>${formatValidUntil(details.validUntil)}</b>`,
    '',
    'Use /autoorder to set up or manage auto-booking.'
  ].join('\n')
}

const getCompensationDetails = async (
  user: HydratedUser,
  now: Date
): Promise<CompensationDetails> => {
  const paidPayment = await PaymentModel.findOne({
    user: user._id,
    amount: { $gt: 0 },
    status: 'paid',
    validUntil: { $gt: now }
  }).sort({ validUntil: -1, createdAt: -1 })

  if (paidPayment?.validUntil) {
    return {
      type: 'paid_extension',
      durationInDays: PAID_COMPENSATION_DAYS,
      validUntil: addDays(paidPayment.validUntil, PAID_COMPENSATION_DAYS)
    }
  }

  return {
    type: 'free_access',
    durationInDays: FREE_COMPENSATION_DAYS,
    validUntil: addDays(now, FREE_COMPENSATION_DAYS)
  }
}

const getStoredCompensationDetails = (
  payment: HydratedPayment | null
): CompensationDetails | undefined => {
  const payload = payment?.callbackPayload
  if (!payload || typeof payload !== 'object' || !payment?.validUntil) {
    return undefined
  }

  const { compensationType, durationInDays } = payload as Record<
    string,
    unknown
  >

  if (
    (compensationType !== 'paid_extension' &&
      compensationType !== 'free_access') ||
    typeof durationInDays !== 'number'
  ) {
    return undefined
  }

  return {
    type: compensationType,
    durationInDays,
    validUntil: payment.validUntil
  }
}

export const addressSessionCompensationSeeder = async () => {
  await mongoose.connect(env.MONGO_URI)

  const result = {
    totalUsers: 0,
    paidUsersExtended: 0,
    freeUsersGranted: 0,
    alreadyCompensated: 0,
    notified: 0,
    notificationFailures: 0
  }

  for await (const user of UserModel.find({ isBlocked: false }).cursor()) {
    result.totalUsers++

    const referenceId = buildReferenceId(user)
    let payment = await PaymentModel.findOne({ referenceId })
    let details = getStoredCompensationDetails(payment)

    if (!payment) {
      details = await getCompensationDetails(user, new Date())
      payment = await PaymentModel.create({
        user: user._id,
        tgId: user.tgId,
        amount: 0,
        currency: 'INR',
        status: 'paid',
        referenceId,
        razorpayPaymentLinkId: referenceId,
        shortUrl: `compensation://${referenceId}`,
        paidAt: new Date(),
        validUntil: details.validUntil,
        callbackPayload: {
          source: COMPENSATION_SOURCE,
          compensationType: details.type,
          durationInDays: details.durationInDays
        }
      })

      user.set('orderSettings.permitted', true)
      user.set('orderSettings.enabled', true)
      await user.save()

      if (details.type === 'paid_extension') {
        result.paidUsersExtended++
      } else {
        result.freeUsersGranted++
      }
    } else {
      result.alreadyCompensated++
    }

    if (!details) {
      console.error(
        `Compensation payment ${payment._id} has invalid compensation metadata.`
      )
      continue
    }

    const payload = payment.callbackPayload as Record<string, unknown>
    if (payload.notificationSentAt || !user.tgId) {
      continue
    }

    try {
      await bot.telegram.sendMessage(user.tgId, buildMessage(details), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }
      })

      payment.set('callbackPayload', {
        ...payload,
        notificationSentAt: new Date().toISOString()
      })
      await payment.save()
      result.notified++
    } catch (err) {
      result.notificationFailures++
      console.error(`Failed to notify compensation user ${user._id}:`, err)
    }
  }

  console.log('Address-session compensation migration completed:', result)
  return result
}
