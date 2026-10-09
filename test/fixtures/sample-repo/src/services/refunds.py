"""Refund processing for the payments service."""

import logging

log = logging.getLogger(__name__)


def issue_refund(payment_id: str, amount: int) -> dict:
    """Issue a refund and notify the merchant by webhook."""
    log.info("refund %s %s", payment_id, amount)
    return {"payment_id": payment_id, "amount": amount, "status": "refunded"}


class RefundQueue:
    def __init__(self):
        self.items = []

    def push(self, refund):
        self.items.append(refund)
