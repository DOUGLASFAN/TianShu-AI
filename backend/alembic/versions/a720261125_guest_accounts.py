"""Distinguish temporary guest accounts from registered accounts."""
from alembic import op
import sqlalchemy as sa

revision = 'a720261125'
down_revision = 'f620261120'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('is_guest', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.execute(sa.text('DELETE FROM users WHERE is_guest IS TRUE'))
    op.drop_column('users', 'is_guest')
